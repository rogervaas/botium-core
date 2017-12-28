const util = require('util')
const async = require('async')
const io = require('socket.io-client')
const debug = require('debug')('botium-GridContainer')

const Commands = require('../Commands')
const Events = require('../Events')
const Capabilities = require('../Capabilities')
const BaseContainer = require('./BaseContainer')
const BotiumMockMessage = require('../mocks/BotiumMockMessage')

module.exports = class GridContainer extends BaseContainer {
  Validate () {
    return super.Validate().then(() => {
      this._AssertCapabilityExists(Capabilities.BOTIUMGRIDURL)
    })
  }

  Build () {
    this.buildPromise = this._defer()

    async.series([
      (baseComplete) => {
        super.Build().then(() => baseComplete()).catch(baseComplete)
      },

      (socketComplete) => {
        this.socket = io(this.caps[Capabilities.BOTIUMGRIDURL])

        this.socket.on('connect', () => {
          debug('connected')
          this.socket.emit('authentication', { apiToken: this.caps[Capabilities.BOTIUMAPITOKEN] })
        })
        this.socket.on('connect_error', (err) => {
          debug(`connect_error ${util.inspect(err)}`)
        })
        this.socket.on('connect_timeout', (timeout) => {
          debug(`connect_timeout ${util.inspect(timeout)}`)
        })
        this.socket.on('error', (err) => {
          debug(`error ${util.inspect(err)}`)
        })
        this.socket.on('authenticated', () => {
          debug('authenticated')
          this.socket.emit(Commands.BUILD_CONTAINER, this.caps, this.repo.sources, this.envs)
        })
        this.socket.on('unauthorized', (err) => {
          debug(`unauthorized ${util.inspect(err)}`)
          socketComplete(`Grid Access not authorized: ${util.inspect(err)}`)
        })
        this.socket.on(Events.TOOMUCHWORKERS_ERROR, (err) => {
          debug(`TOOMUCHWORKERS_ERROR ${util.inspect(err)}`)
          socketComplete(`Grid Access not possible: ${util.inspect(err)}`)
        })
        this.socket.on(Events.CONTAINER_BUILT, () => {
          debug(Events.CONTAINER_BUILT)
          socketComplete()
        })
        this.socket.on(Events.CONTAINER_BUILD_ERROR, (err) => {
          debug(`CONTAINER_BUILD_ERROR ${util.inspect(err)}`)
          socketComplete(`Grid Build failed: ${util.inspect(err)}`)
        })

        this.socket.on(Events.CONTAINER_STARTED, () => {
          debug(Events.CONTAINER_STARTED)
          this.eventEmitter.emit(Events.CONTAINER_STARTED, this)
          if (this.startPromise) {
            this.startPromise.resolve(this)
            this.startPromise = null
          }
        })
        this.socket.on(Events.CONTAINER_START_ERROR, (err) => {
          debug(`CONTAINER_START_ERROR ${util.inspect(err)}`)
          this.eventEmitter.emit(Events.CONTAINER_START_ERROR, this, err)
          if (this.startPromise) {
            this.startPromise.reject(`Grid Start failed: ${util.inspect(err)}`)
            this.startPromise = null
          }
        })

        this.socket.on(Events.MESSAGE_RECEIVEDFROMBOT, (botMsg) => {
          debug(`MESSAGE_RECEIVEDFROMBOT ${util.inspect(botMsg)}`)
          this._QueueBotSays(new BotiumMockMessage(botMsg))
          this.eventEmitter.emit(Events.MESSAGE_RECEIVEDFROMBOT, this, botMsg)
        })

        this.socket.on(Events.CONTAINER_STOPPED, () => {
          debug(Events.CONTAINER_STOPPED)
          this.eventEmitter.emit(Events.CONTAINER_STOPPED, this)
          if (this.stopPromise) {
            this.stopPromise.resolve(this)
            this.stopPromise = null
          }
        })
        this.socket.on(Events.CONTAINER_STOP_ERROR, (err) => {
          debug(`CONTAINER_STOP_ERROR ${util.inspect(err)}`)
          this.eventEmitter.emit(Events.CONTAINER_STOP_ERROR, this, err)
          if (this.stopPromise) {
            this.stopPromise.reject(`Grid Stop failed: ${util.inspect(err)}`)
            this.stopPromise = null
          }
        })

        this.socket.on(Events.CONTAINER_CLEANED, () => {
          debug(Events.CONTAINER_CLEANED)
          this.eventEmitter.emit(Events.CONTAINER_CLEANED, this)
          if (this.cleanPromise) {
            this.cleanPromise.resolve(this)
            this.cleanPromise = null
          }
          this.socket.disconnect()
          this.socket = null
        })
        this.socket.on(Events.CONTAINER_CLEAN_ERROR, (err) => {
          debug(`CONTAINER_CLEAN_ERROR ${JSON.stringify(err)}`)
          this.eventEmitter.emit(Events.CONTAINER_CLEAN_ERROR, this, err)
          if (this.cleanPromise) {
            this.cleanPromise.reject(`Grid Clean failed: ${util.inspect(err)}`)
            this.cleanPromise = null
          }
          this.socket.disconnect()
          this.socket = null
        })
      }
    ], (err) => {
      if (err) {
        this.buildPromise.reject(new Error(`Cannot build docker containers: ${util.inspect(err)}`))
      } else {
        this.buildPromise.resolve(this)
      }
      this.buildPromise = null
    })
    return this.buildPromise.promise
  }

  Start () {
    this.eventEmitter.emit(Events.CONTAINER_STARTING, this)

    return super.Start().then(() => {
      if (this.startPromise) return Promise.reject(new Error('already starting'))
      if (this.socket) {
        this.startPromise = this._defer()
        this.socket.emit(Commands.START_CONTAINER)

        return this.startPromise.promise
      } else {
        this.eventEmitter.emit(Events.CONTAINER_START_ERROR, this, 'Remote Agent not online')
        return Promise.reject(new Error('Remote Agent not online'))
      }
    })
  }

  UserSays (mockMsg) {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        this.socket.emit(Commands.SENDTOBOT, mockMsg)
        this.eventEmitter.emit(Events.MESSAGE_SENTTOBOT, this, mockMsg)
        resolve(this)
      } else {
        this.eventEmitter.emit(Events.MESSAGE_SENDTOBOT_ERROR, this, 'Remote Agent not online')
        reject(new Error('Remote Agent not online'))
      }
    })
  }

  Stop () {
    this.eventEmitter.emit(Events.CONTAINER_STOPPING, this)

    return super.Stop().then(() => {
      if (this.stopPromise) return Promise.reject(new Error('already stopping'))
      if (this.socket) {
        this.stopPromise = this._defer()
        this.socket.emit(Commands.STOP_CONTAINER)

        return this.stopPromise.promise
      } else {
        return Promise.resolve(this)
      }
    })
  }

  Clean () {
    this.eventEmitter.emit(Events.CONTAINER_CLEANING, this)

    return super.Clean().then(() => {
      if (this.cleanPromise) return Promise.reject(new Error('already cleaning'))
      if (this.socket) {
        this.cleanPromise = this._defer()
        this.socket.emit(Commands.CLEAN_CONTAINER)

        return this.cleanPromise.promise
      } else {
        return Promise.resolve(this)
      }
    })
  }

  _defer () {
    const deferred = {
      promise: null,
      resolve: null,
      reject: null
    }
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve
      deferred.reject = reject
    })
    return deferred
  }
}
