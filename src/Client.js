const EventEmitter = require(`events`);
const uuid = require('uuid/v1');
const ProxyClient = require(`./ProxyClient`);
const Utils = require(`./utils/Utils`);
const { MessageUtils, MessageBuilder } = require(`devicehive-proxy-message`);
const Request = require(`./message/Request`);
const Response = require(`./message/Response`);
const IncomingMessage = require(`./message/IncomingMessage`);
const ErrorResponseBody = require(`./message/body/ErrorResponseBody`);
const HandlerFactory = require(`./HandlerFactory`);


/**
 *
 */
class Client extends EventEmitter {

    /**
     * Returns Response object for ping request
     * @param request
     * @returns {Response}
     */
    static _getPongResponse(request) {
        return new Response({ correlationId: request.correlationId });
    }

    /**
     * Returns ErrorResponse object
     * @param request
     * @param code
     * @param message
     * @returns {Response}
     */
    static _getErrorResponse(request, code, message) {
        const response = new Response({
            correlationId: request.correlationId,
            failed: true
        });

        response.withErrorCode(code);
        response.withBody(new ErrorResponseBody({message}));

        return response;
    }


    constructor( {
        webSocketServerUrl=`ws://localhost:3000`,
        autoReconnectIntervalMs=5000,
        persistMessageWhileReconnecting=true,
        topicsToSubscribe=[],
        subscriptionGroup=``,
        handlerFactory = new HandlerFactory()
    } = {}) {
        super();

        this._ee = new EventEmitter();
        this._handlerFactory = handlerFactory;
        this._proxyClient = new ProxyClient({
            webSocketServerUrl,
            autoReconnectIntervalMs,
            persistMessageWhileReconnecting
        });

        this.proxyClient.on(`error`, (err) => this.emit(`error`, err));

        this.proxyClient.on(`open`, () => {
            if (!Utils.isEmpty(topicsToSubscribe)) {
                const subscriptionMessageId = uuid();

                this.proxyClient.sendMessage(MessageBuilder.subscribeTopic({
                    topicList: topicsToSubscribe,
                    subscriptionGroup: subscriptionGroup
                }, subscriptionMessageId));

                this._ee.on(subscriptionMessageId, (subscriptionResponse) => {
                    if (subscriptionResponse.status === MessageUtils.SUCCESS_STATUS) {
                        this.emit(`ready`);
                    }
                })
            }
        });

        this.proxyClient.on(`message`, async (message) => {
            try {
                switch(message.type) {
                    case MessageUtils.NOTIFICATION_TYPE:
                        const payload = message.payload;

                        if (payload && payload.message) {
                            await this._handleIncomingMessage(IncomingMessage.normalize(JSON.parse(payload.message)));
                        }
                        break;
                    case MessageUtils.TOPIC_TYPE:
                        if (message.action === MessageUtils.SUBSCRIBE_ACTION) {
                            await this._handleSubscriptionResponseMessage(message);
                        }
                        break;
                }
            } catch (err) {
                this.emit(`error`, err);
            }
        });
    }

    /**
     *
     */
    get proxyClient() {
        return this._proxyClient;
    }


    /**
     *
     * @param topic
     * @param partition
     * @param request
     * @param withResponse
     * @param responseTimeOut
     * @returns {Promise<any>}
     */
    sendRequest({ topic, partition, request, withResponse=true, responseTimeOut }={}) {
        return new Promise((resolve, reject) => {
            this.proxyClient.sendMessage(MessageBuilder.createNotification({
                topic: topic,
                message: request.toString(),
                partition: partition,
                type: MessageUtils.REQUEST_NOTIFICATION
            }));

            if (withResponse) {
                let timerHandler;

                this._ee.once(request.correlationId, (response) => {
                    clearTimeout(timerHandler);

                    if (response.failed) {
                        reject(response);
                    } else {
                        resolve(response);
                    }
                });

                if (responseTimeOut) {
                    timerHandler = setTimeout(() => {
                        this._ee.removeAllListeners(request.correlationId);
                        reject(new Error(`Request #${request.correlationId} timeout`));
                    }, responseTimeOut);
                }
            } else {
                resolve();
            }
        });
    }

    /**
     *
     * @param topic
     * @param partition
     * @param response
     */
    sendResponse({ topic, partition, response }={}) {
        this.proxyClient.sendMessage(MessageBuilder.createNotification({
            topic: topic,
            message: response.toString(),
            partition: partition,
            type: MessageUtils.RESPONSE_NOTIFICATION
        }));
    }

    /**
     *
     * @param message
     * @returns {Promise<void>}
     */
    async _handleSubscriptionResponseMessage(message) {
        if (message.id) {
            this._ee.emit(message.id, message);
        }
    }

    /**
     *
     * @param incomingMessage
     * @returns {Promise<void>}
     */
    async _handleIncomingMessage(incomingMessage = {}) {
        if (incomingMessage.isRequest) {
            await this._handleRequestMessage(incomingMessage);
        } else if (incomingMessage.isResponse) {
            await this._handleResponseMessage(incomingMessage);
        } else {
            throw new Error(`Unknown incoming message type`);
        }
    }

    /**
     *
     * @param request
     * @returns {Promise<void>}
     */
    async _handleRequestMessage(request) {
        let response;

        switch (request.type) {
            case Request.PING_TYPE:
                response = Client._getPongResponse(request);
                break;
            case Request.CLIENT_REQUEST_TYPE:
                response = await this._handleClientRequest(request);
                break;
            default:
                response = Client._getErrorResponse(request);
                break;
        }

        if (response) {
            this.sendResponse({ topic: request.replyTo, partition: request.partitionKey, response: response });
        }
    }

    /**
     *
     * @param response
     * @returns {Promise<void>}
     */
    async _handleResponseMessage(response) {
        if (response.correlationId) {
            this._ee.emit(response.correlationId, response);
        }
    }

    /**
     * Client request handler
     * @param request
     * @returns {Promise<Response>}
     */
    async _handleClientRequest(request) {
        const requestHandler =  this._handlerFactory.getHandlerByAction(request.body.action);
        let response = new Response();

        if (!requestHandler) {
            response = Client._getErrorResponse(request, 500, `No corresponding request handler`);
        } else {
            try {
                response = await requestHandler(request);
            } catch (error) {
                response = Client._getErrorResponse(request, 500, error.message)
            }
        }

        response.correlationId = request.correlationId;

        return response;
    }
}


module.exports = Client;
