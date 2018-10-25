import ApiClient from '@arkecosystem/client'
import { transactionBuilder } from '@arkecosystem/crypto'
import { castArray } from 'lodash'
import dayjs from 'dayjs'
import store from '@/store'
import eventBus from '@/plugins/event-bus'

export default class ClientService {
  constructor (watchProfile = true) {
    this.__host = null
    this.__version = null
    this.client = new ApiClient('http://')

    if (watchProfile) {
      this.__watchProfile()
    }
  }

  /**
   * Fetch the network configuration according to the version.
   * Create a new client to isolate the main client.
   *
   * @param {String} server
   * @param {Number} apiVersion
   * @param {Number} timeout
   * @returns {Object}
   */
  static async fetchNetworkConfig (server, apiVersion, timeout) {
    const client = new ApiClient(server, apiVersion)
    if (timeout) {
      client.http.timeout = timeout
    }

    if (apiVersion === 1) {
      const { data } = await client.resource('loader').status()

      return data.network
    } else {
      const { data } = await client.resource('node').configuration()

      return data.data
    }
  }

  get host () {
    return this.__host
  }

  set host (host) {
    this.__host = host
    this.client.setConnection(host)
  }

  get version () {
    return this.__version
  }

  set version (apiVersion) {
    this.__version = apiVersion
    this.client.setVersion(apiVersion)
  }

  /**
   * Fetch the peer status.
   * @returns {Object}
   */
  async fetchPeerStatus () {
    if (this.__version === 1) {
      return (await this.client.resource('loader').configuration()).data
    } else {
      return (await this.client.resource('node').syncing()).data.data
    }
  }

  async fetchDelegates () {
    let delegates = []
    const { data } = await this.client.resource('delegates').all()

    if (this.__version === 2) {
      delegates = data.data
    } else if (data.success) {
      delegates = data.delegates.map(delegate => {
        return {
          ...delegate,
          production: {
            approval: delegate.approval,
            productivity: delegate.productivity
          },
          blocks: {
            produced: delegate.producedblocks,
            missed: delegate.missedblocks
          },
          rank: delegate.rate
        }
      })
    }

    return delegates
  }

  async fetchDelegateForged (delegate) {
    if (delegate.forged) {
      return delegate.forged.total
    }
    const { data } = await this.client.resource('delegates').forged(delegate.publicKey)
    if (data.success) {
      return data.forged
    }
    return 0
  }

  /**
   * Request the transactions according to the current network version
   *
   * V1:
   *   - The timestamp returned from the api is relative to the mainnet release date.
   *   - Map keys to match the v2 response structure.
   *
   * V2:
   *   - The timestamp field is an object that already returns converted date.
   *
   * @param {String} address
   * @param {Object} [query]
   * @param {Number} [query.page=0]
   * @param {Number} [query.limit=50]
   * @return {Object[]}
   */
  async fetchTransactions (address, { page, limit, orderBy } = { page: 0, limit: 50, orderBy: 'timestamp:desc' }) {
    let totalCount = 0
    let transactions = []

    if (this.__version === 1) {
      const network = store.getters['session/network']
      const { data } = await this.client.resource('transactions').all({
        recipientId: address,
        senderId: address,
        orderBy,
        offset: (page - 1) * limit,
        limit
      })

      if (data.success) {
        transactions = data.transactions.map(tx => {
          tx.timestamp = dayjs(network.constants.epoch).add(tx.timestamp * 1000).toDate()
          tx.sender = tx.senderId
          tx.recipient = tx.recipientId

          delete tx.senderId
          delete tx.recipientId

          return tx
        })
        totalCount = parseInt(data.count)
      }
    } else {
      // TODO: Add orderBy field in the v2 query params
      const { data } = await this.client.resource('wallets').transactions(address, {
        limit,
        page
      })

      transactions = data.data.map(tx => {
        tx.timestamp = dayjs(tx.timestamp.human).toDate()
        return tx
      })
      totalCount = data.meta.totalCount
    }

    // Add some utilities for each transactions
    const result = transactions.map(tx => {
      tx.isSender = tx.sender === address
      tx.isReceiver = tx.recipient === address
      tx.totalAmount = tx.amount + tx.fee

      return tx
    })

    return {
      transactions: result,
      totalCount
    }
  }

  /**
   * Request the data to the wallet endpoint and unify the returned value
   *
   * V1:
   * {"success":true,"account":{"address":"ANQYF8y8PBmg67hSGCA7e67d84sgm8zH3k","unconfirmedBalance":"243884095406","balance":"243884095406","publicKey":null,"unconfirmedSignature":0,"secondSignature":0,"secondPublicKey":null,"multisignatures":[],"u_multisignatures":[]}}
   *
   * V2:
   * {"address":"DPFPtDfexMrSiZEB1o3TiJTUYBnnHrzFrD","publicKey":null,"secondPublicKey":null,"balance":1,"isDelegate":false}
   *
   * @param {String} address
   * @return {Object}
   */
  async fetchWallet (address) {
    let walletData = null

    if (this.__version === 2) {
      const { data } = await this.client.resource('wallets').get(address)
      walletData = data.data
    } else {
      const { data } = await this.client.resource('accounts').get(address)
      if (data.success) {
        const { account } = data
        walletData = account
        walletData.isDelegate = walletData.username !== null
        delete walletData.unconfirmedBalance
        delete walletData.unconfirmedSignature
        delete walletData.secondSignature
        delete walletData.multisignatures
        delete walletData.u_multisignatures
      }
    }

    if (walletData) {
      walletData.balance = parseInt(walletData.balance)
    }

    return walletData
  }

  /**
   * Request the vote of a wallet.
   * Returns the delegate's public key if this wallet has voted.
   * @param {String} address
   * @returns {String|null}
   */
  async fetchWalletVote (address) {
    let delegatePublicKey = null

    if (this.version === 2) {
      const { data } = await this.client.resource('wallets').votes(address)
      const response = data.data

      if (response.length) {
        delegatePublicKey = response[0].asset.votes[0].substring(1)
      }
    } else {
      const { data } = await this.client.resource('accounts').delegates(address)
      if (data.success && data.delegates.length) {
        delegatePublicKey = data.delegates[0].publicKey
      }
    }

    return delegatePublicKey
  }

  /**
   * Request peer list.
   * @param {String} network
   * @param {Object[]} [peers=[]]
   * @returns {Object[]}
   */
  async fetchPeers (network, peers = []) {
    if (network) {
      peers = null
    } else if (!network && !peers.length) {
      peers = [this.__parseCurrentPeer()]
    }

    return ApiClient.findPeers(network, this.client.version, peers)
  }

  /**
   * Parse peer from current client host.
   * @return {Object}
   */
  __parseCurrentPeer () {
    const matches = /(https?:\/\/)([a-zA-Z0-9.-_]+):([0-9]+)/.exec(this.client.http.host)
    const scheme = matches[1]
    const ip = matches[2]
    let port = scheme === 'https://' ? 443 : 80
    if (matches[3]) {
      port = matches[3]
    }

    return {
      ip,
      port
    }
  }

  /**
   * Build a vote transaction
   * @param {Array} votes
   * @param {String} passphrase
   * @param {String} secondPassphrase
   * @param {String} wif
   * @returns {Object}
   */
  async buildVote ({ votes, passphrase, secondPassphrase, wif }) {
    let vote = transactionBuilder
      .vote()
      .votesAsset(votes)

    if (passphrase) {
      vote = vote.sign(passphrase)
    } else if (wif) {
      vote = vote.signWithWif(wif)
    }

    if (secondPassphrase) {
      vote = vote.secondSign(secondPassphrase)
    }

    return vote.getStruct()
  }

  /**
   * Build a delegate registration transaction
   * @param {String} username
   * @param {String} passphrase
   * @param {String} secondPassphrase
   * @param {String} wif
   * @returns {Object}
   */
  async buildDelegateRegistration ({ username, passphrase, secondPassphrase, wif }) {
    let delegateRegistration = transactionBuilder
      .delegateRegistration()
      .usernameAsset(username)

    if (passphrase) {
      delegateRegistration = delegateRegistration.sign(passphrase)
    } else if (wif) {
      delegateRegistration = delegateRegistration.signWithWif(wif)
    }

    if (secondPassphrase) {
      delegateRegistration = delegateRegistration.secondSign(secondPassphrase)
    }

    return delegateRegistration.getStruct()
  }

  /**
   * Build a transfer transaction.
   * TODO: amount -> convert to arktoshi
   * @param {Number} amount
   * @param {String} recipientId
   * @param {String} vendorField
   * @param {String} passphrase
   * @param {String} secondPassphrase
   * @param {String} wif
   * @returns {Object}
   */
  async buildTransfer ({ amount, recipientId, vendorField, passphrase, secondPassphrase, wif }) {
    let transfer = transactionBuilder
      .transfer()
      .amount(amount)
      .recipientId(recipientId)
      .vendorField(vendorField)

    if (passphrase) {
      transfer = transfer.sign(passphrase)
    } else if (wif) {
      transfer = transfer.signWithWif(wif)
    }

    if (secondPassphrase) {
      transfer = transfer.secondSign(secondPassphrase)
    }

    return transfer.getStruct()
  }

  /**
   * Build a second signature registration transaction.
   * @param {String} passphrase
   * @param {String} secondPassphrase
   * @param {String} wif
   * @returns {Object}
   */
  async buildSecondSignatureRegistration ({ passphrase, secondPassphrase, wif }) {
    let registration = transactionBuilder
      .secondSignature()
      .signatureAsset(secondPassphrase)

    if (passphrase) {
      registration = registration.sign(passphrase)
    } else if (wif) {
      registration = registration.signWithWif(wif)
    }

    return registration.getStruct()
  }

  /**
   * Broadcast transactions to the current peer.
   *
   * @param {Array|Object} transactions
   * @returns {Object}
   */
  async broadcastTransaction (transactions) {
    const transaction = await this
      .client
      .resource('transactions')
      .create({
        transactions: castArray(transactions)
      })

    return transaction
  }

  __watchProfile () {
    store.watch(
      (_, getters) => getters['session/profile'],
      (profile) => {
        if (!profile) return

        const { server, apiVersion } = store.getters['network/byId'](profile.networkId)
        const currentPeer = store.getters['peer/current']()

        if (currentPeer && Object.keys(currentPeer).length > 0) {
          this.host = `http://${currentPeer.ip}:${currentPeer.port}`
          this.version = currentPeer.version.match(/^2\./) ? 2 : 1
        } else {
          this.host = server
          this.version = apiVersion
        }

        eventBus.emit('client:changed')
      },
      { immediate: true }
    )
  }
}
