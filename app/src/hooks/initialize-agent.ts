import { Agent, HttpOutboundTransport, MediatorPickupStrategy, WsOutboundTransport } from '@credo-ts/core'
import { IndyVdrPoolConfig, IndyVdrPoolService } from '@credo-ts/indy-vdr/build/pool'
import { useAgent } from '@credo-ts/react-hooks'
import { agentDependencies } from '@credo-ts/react-native'
import {
  DispatchAction,
  useAuth,
  useStore,
  migrateToAskar,
  createLinkSecretIfRequired,
  TOKENS,
  useServices,
  PersistentStorage,
} from '@hyperledger/aries-bifold-core'
import { GetCredentialDefinitionRequest, GetSchemaRequest } from '@hyperledger/indy-vdr-shared'
import moment from 'moment'
import { useCallback } from 'react'
import { Config } from 'react-native-config'
import { CachesDirectoryPath } from 'react-native-fs'
import { activate } from '../helpers/PushNotificationsHelper'
import { getBCAgentModules } from '../helpers/bc-agent-modules'
import { BCState, BCLocalStorageKeys } from '../store'

const loadCachedLedgers = async (): Promise<IndyVdrPoolConfig[] | undefined> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cachedTransactions = await PersistentStorage.fetchValueForKey<any>(BCLocalStorageKeys.GenesisTransactions)
  if (cachedTransactions) {
    const { timestamp, transactions } = cachedTransactions
    return moment().diff(moment(timestamp), 'days') >= 1 ? undefined : transactions
  }
}

const useInitializeBCAgent = () => {
  const { setAgent } = useAgent()
  const [store, dispatch] = useStore<BCState>()
  const { walletSecret } = useAuth()
  const [logger, indyLedgers, attestationMonitor, credDefs, schemas] = useServices([
    TOKENS.UTIL_LOGGER,
    TOKENS.UTIL_LEDGERS,
    TOKENS.UTIL_ATTESTATION_MONITOR,
    TOKENS.CACHE_CRED_DEFS,
    TOKENS.CACHE_SCHEMAS,
  ])

  const createNewAgent = useCallback(
    async (ledgers: IndyVdrPoolConfig[]): Promise<Agent | undefined> => {
      if (!walletSecret?.id || !walletSecret.key) {
        return
      }

      logger.info('No agent initialized, creating a new one')

      const options = {
        config: {
          label: store.preferences.walletName || 'ASML Wallet',
          walletConfig: {
            id: walletSecret.id,
            key: walletSecret.key,
          },
          logger,
          mediatorPickupStrategy: MediatorPickupStrategy.Implicit,
          autoUpdateStorageOnStartup: true,
          autoAcceptConnections: true,
        },
        dependencies: agentDependencies,
        modules: getBCAgentModules({
          indyNetworks: ledgers,
          mediatorInvitationUrl: Config.MEDIATOR_URL,
          txnCache: {
            capacity: 1000,
            expiryOffsetMs: 1000 * 60 * 60 * 24 * 7,
            path: CachesDirectoryPath + '/txn-cache',
          },
          enableProxy: store.developer.enableProxy,
          proxyBaseUrl: Config.INDY_VDR_PROXY_URL,
          proxyCacheSettings: {
            allowCaching: false,
            cacheDurationInSeconds: 60 * 60 * 24 * 7,
          },
        }),
      }

      logger.info(store.developer.enableProxy && Config.INDY_VDR_PROXY_URL ? 'VDR Proxy enabled' : 'VDR Proxy disabled')

      logger.debug(`Mediator URL: ${Config.MEDIATOR_URL}`)

      const newAgent = new Agent(options)
      const wsTransport = new WsOutboundTransport()
      const httpTransport = new HttpOutboundTransport()

      newAgent.registerOutboundTransport(wsTransport)
      newAgent.registerOutboundTransport(httpTransport)

      return newAgent
    },
    [walletSecret, store.preferences.walletName, logger, store.developer.enableProxy]
  )

  const migrateIfRequired = useCallback(
    async (newAgent: Agent) => {
      if (!walletSecret?.id || !walletSecret.key) {
        return
      }

      // If we haven't migrated to Aries Askar yet, we need to do this before we initialize the agent.
      if (!store.migration.didMigrateToAskar) {
        logger.debug('Agent not updated to Aries Askar, updating...')

        await migrateToAskar(walletSecret.id, walletSecret.key, newAgent)

        logger.debug('Successfully finished updating agent to Aries Askar')
        // Store that we migrated to askar.
        dispatch({
          type: DispatchAction.DID_MIGRATE_TO_ASKAR,
        })
      }
    },
    [walletSecret, store.migration.didMigrateToAskar, dispatch, logger]
  )

  const warmUpCache = useCallback(
    async (newAgent: Agent, cachedLedgers?: IndyVdrPoolConfig[]) => {
      const poolService = newAgent.dependencyManager.resolve(IndyVdrPoolService)
      if (!cachedLedgers) {
        // these escapes can be removed once Indy VDR has been upgraded and the patch is no longer needed
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore:next-line
        await poolService.refreshPoolConnections()
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore:next-line
        const raw_transactions = await poolService.getAllPoolTransactions()
        const transactions = raw_transactions
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore:next-line
          .map((item) => item.value)
          .map(({ config, transactions }) => ({
            ...config,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore:next-line
            genesisTransactions: transactions.reduce((prev, curr) => {
              return prev + JSON.stringify(curr)
            }, ''),
          }))
        if (transactions) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await PersistentStorage.storeValueForKey<any>(BCLocalStorageKeys.GenesisTransactions, {
            timestamp: moment().toISOString(),
            transactions,
          })
        }
      }

      credDefs.forEach(async ({ did, id }) => {
        const pool = await poolService.getPoolForDid(newAgent.context, did)
        const credDefRequest = new GetCredentialDefinitionRequest({ credentialDefinitionId: id })
        await pool.pool.submitRequest(credDefRequest)
      })

      schemas.forEach(async ({ did, id }) => {
        const pool = await poolService.getPoolForDid(newAgent.context, did)
        const schemaRequest = new GetSchemaRequest({ schemaId: id })
        await pool.pool.submitRequest(schemaRequest)
      })
    },
    [credDefs, schemas]
  )

  const initializeAgent = useCallback(async (): Promise<Agent | undefined> => {
    try {
      if (!walletSecret?.id || !walletSecret.key) {
        logger.error('Missing wallet secret credentials')
        return
      }

      logger.debug('Loading cached ledgers...')
      const cachedLedgers = await loadCachedLedgers()
      const ledgers = cachedLedgers ?? indyLedgers

      logger.debug(`Using ledgers: ${JSON.stringify(ledgers, null, 2)}`)

      logger.debug('Creating new agent...')
      const newAgent = await createNewAgent(ledgers)
      if (!newAgent) {
        logger.error('Failed to create new agent')
        return
      }

      logger.info('Migrating agent if required...')
      try {
        await migrateIfRequired(newAgent)
      } catch (e: unknown) {
        logger.error(`Migration failed: ${(e as Error).message}`)
        throw e
      }

      logger.info('Initializing new agent...')
      try {
        await Promise.race([
          newAgent.initialize(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Agent initialization timed out after 60s')), 60000)
          ),
        ])
      } catch (e: unknown) {
        logger.error(`Agent initialization failed: ${(e as Error).message}`)
        logger.error('Agent config:', newAgent.config)
        throw e
      }

      logger.info('Warming up cache...')
      try {
        await warmUpCache(newAgent, cachedLedgers)
      } catch (e: unknown) {
        logger.error(`Cache warmup failed: ${(e as Error).message}`)
        // Don't throw here as this is non-critical
      }

      logger.info('Creating link secret if required...')
      try {
        await createLinkSecretIfRequired(newAgent)
      } catch (e: unknown) {
        logger.error(`Link secret creation failed: ${(e as Error).message}`)
        throw e
      }

      if (store.preferences.usePushNotifications) {
        logger.info('Activating push notifications...')
        try {
          await activate(newAgent)
        } catch (e: unknown) {
          logger.error(`Push notification activation failed: ${(e as Error).message}`)
          // Don't throw as this is non-critical
        }
      }

      // In case the old attestationMonitor is still active, stop it and start a new one
      logger.info('Starting attestation monitor...')
      try {
        attestationMonitor?.stop()
        attestationMonitor?.start(newAgent)
      } catch (e: unknown) {
        logger.error(`Attestation monitor setup failed: ${(e as Error).message}`)
        // Don't throw as this is non-critical
      }

      logger.info('Setting new agent...')
      setAgent(newAgent)

      logger.debug('Agent initialization completed successfully')

      return newAgent
    } catch (error: unknown) {
      logger.error('Agent initialization failed:', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }, [
    setAgent,
    createNewAgent,
    migrateIfRequired,
    warmUpCache,
    store.preferences.usePushNotifications,
    walletSecret,
    logger,
    indyLedgers,
    attestationMonitor,
  ])

  return { initializeAgent }
}

export default useInitializeBCAgent
