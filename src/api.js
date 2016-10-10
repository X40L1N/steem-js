import Debug from 'debug';
import EventEmitter from 'events';
import Promise from 'bluebird';
import cloneDeep from 'lodash/cloneDeep';
import isNode from 'detect-node';

import methods from './methods';
import {camelCase} from './util';

const debugEmitters = Debug('steem:emitters');
const debugProtocol = Debug('steem:protocol');
const debugSetup = Debug('steem:setup');
const debugWs = Debug('steem:ws');

let WebSocket;
if (isNode) {
  WebSocket = require('ws'); // eslint-disable-line global-require
} else if (typeof window !== 'undefined') {
  WebSocket = window.WebSocket;
} else {
  throw new Error('Couldn\'t decide on a `WebSocket` class');
}

const DEFAULTS = {
  url: 'wss://steemit.com/wspa',
  apiIds: {
    database_api: 0,
    login_api: 1,
    follow_api: 3,
    network_broadcast_api: 2
  },
  id: 0,
};

class Steem extends EventEmitter {
  constructor(options = {}) {
    super(options);
    Object.assign(options, DEFAULTS);
    this.options = cloneDeep(options);

    this.id = 0;
    this.inFlight = 0;
    this.currentP = Promise.fulfilled();
    this.apiIds = this.options.apiIds;
    this.isOpen = false;
    this.releases = [];
  }

  setWebSocket(url) {
    this.options.url = url;
    this.stop();
  }

  start() {
    if (this.startP) return this.startP;

    const startP = new Promise((resolve /* , reject*/) => {
      if (startP !== this.startP) return;
      this.ws = new WebSocket(this.options.url);

      const releaseOpen = this.listenTo(this.ws, 'open', () => {
        debugWs('Opened WS connection with', this.options.url);
        this.isOpen = true;
        releaseOpen();
        resolve();
      });

      const releaseClose = this.listenTo(this.ws, 'close', () => {
        debugWs('Closed WS connection with', this.options.url);
        releaseClose();
        this.isOpen = false;
      });

      const releaseMessage = this.listenTo(this.ws, 'message', (message) => {
        debugWs('Received message', message.data);
        releaseMessage();
        this.emit('message', JSON.parse(message.data));
      });

      this.releases = this.releases.concat([
        releaseOpen,
        releaseClose,
        releaseMessage
      ]);
    });

    this.startP = startP;
    this.apiIdsP = this.getApiIds();
    return this.startP;
  }

  stop() {
    if (this.ws) this.ws.close();
    delete this.startP;
    delete this.ws;
    this.releases.forEach((release) => release());
    this.releases = [];
  }

  listenTo(target, eventName, callback) {
    debugEmitters('Adding listener for', eventName, 'from', target.constructor.name);
    if (target.addEventListener) target.addEventListener(eventName, callback);
    else target.on(eventName, callback);

    return () => {
      debugEmitters('Removing listener for', eventName, 'from', target.constructor.name);
      if (target.removeEventListener) target.removeEventListener(eventName, callback);
      else target.removeListener(eventName, callback);
    };
  }

  getApiIds() {
    return Promise.map(Object.keys(this.apiIds), (name) => {
      debugSetup('Syncing API IDs', name);
      return this.getApiByNameAsync(name).then((result) => {
        if (result) {
          this.apiIds[name] = result;
        } else {
          debugSetup('Dropped null API ID for', name);
        }
      });
    });
  }

  waitForSlot() {
    return Promise.delay(100).then(() => {
      if (this.inFlight < 10) return null;

      return this.waitForSlot();
    })
  }

  send(api, data, callback) {
    const id = data.id || this.id++;
    const currentP = this.currentP;
    this.currentP = Promise.join(this.start(), this.waitForSlot())
      .then(() => new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          id,
          method: 'call',
          params: [
            this.apiIds[api],
            data.method,
            data.params,
          ],
        });

        const release = this.listenTo(this, 'message', (message) => {
          // We're still seeing old messages
          if (message.id < id) {
            debugProtocol('Old message was dropped', message);
            return;
          }

          this.inFlight -= 1;
          release();

          // We dropped a message
          if (message.id !== id) {
            debugProtocol('Response to RPC call was dropped', payload);
            return;
          }

          // Our message's response came back
          const errorCause = data.error;
          if (errorCause) {
            const err = new Error(errorCause);
            err.message = data;
            reject(err);
            return;
          }

          debugProtocol('Resolved', id);
          resolve(message.result);
        });

        debugWs('Sending message', payload);
        this.ws.send(payload);
      })
      .then(
        (result) => callback(null, result),
        (err) => callback(err)
      ));

    this.inFlight += 1;

    return this.currentP;
  }

  streamBlockNumber(callback, ts = 200) {
    let current = '';
    let running = true;

    const update = () => {
      if (!running) return;

      let result;
      this.getDynamicGlobalPropertiesAsync()
        .then((result) => {
          const blockId = result.head_block_number;
          if (blockId !== current) {
            current = blockId;
            callback(null, current);
          }

          Promise.delay(ts).then(() => {
            update();
          });
        }, (err) => {
          callback(err);
        });
    };

    update();

    return () => {
      running = false;
    };
  }

  streamBlock(callback) {
    let current = '';
    let last = '';

    const release = this.streamBlockNumber((err, id) => {
      if (err) {
        release();
        callback(err);
        return;
      }

      current = id;
      if (current !== last) {
        last = current;
        this.getBlock(current, callback);
      }
    });

    return release;
  }

  streamTransactions(callback) {
    const release = this.streamBlock((err, result) => {
      if (err) {
        release();
        callback(err);
        return;
      }

      result.transactions.forEach((transaction) => {
        callback(null, transaction);
      });
    });

    return release;
  }

  streamOperations(callback) {
    const release = this.streamTransactions((err, transaction) => {
      if (err) {
        release();
        callback(err);
        return;
      }

      transaction.operations.forEach(function (operation) {
        callback(null, operation);
      });
    });

    return release;
  }
}

// Generate Methods from methods.json
methods.reduce(function (memo, method) {
  const methodName = camelCase(method.method);
  const methodParams = method.params || [];

  memo[methodName + 'With'] =
    function Steem$$specializedSendWith(options, callback) {
      const params = methodParams.map(function (param) {
        return options[param];
      });

      return this.send(method.api, {
        method: method.method,
        params: params,
      }, callback);
    };

  memo[methodName] =
    function Steem$specializedSend(...args) {
      const options = methodParams.reduce(function (memo, param, i) {
        memo[param] = args[i];
        return memo;
      }, {});
      const callback = args[methodParams.length];

      return this[methodName + 'With'](options, callback);
    };

  return memo;
}, Steem.prototype);

Promise.promisifyAll(Steem.prototype);

// Export singleton instance
const steem = new Steem();
exports = module.exports = steem;
exports.Steem = Steem;
exports.Steem.DEFAULTS = DEFAULTS;
