import WildEmitter from 'wildemitter';
import _ from 'lodash';
import {observable} from 'mobx';

import Logger from 'lib/logger';
import Peer from 'lib/rtc/peer';
import Socket from 'lib/socket';
import {fetchPost, fetchJSON} from 'lib/util';
import {Message} from 'app/messages/store';
import {camelize, camelizeKeys, decamelize, decamelizeKeys} from 'lib/util';
import {MESSAGE_TYPES} from './constants';
import FileTransferManager from 'lib/rtc/filetransfer';

export default class RoomConnection extends WildEmitter {
    /**
     * Handles the connection to the signalling server, and to the RTC peers.
     */
    @observable status = null;
    @observable.ref stream = null;
    @observable.shallow peers = [];

    constructor(opts) {
        super();
        this.urls = opts.urls || {};
        this.room = opts.room;
        this.fs = opts.fs;

        this.peers = [];
        this.selfPeerId = null;
        this.localMedia = [];

        this.socket = new Socket({url: this.urls.socket});
        this.socket.on('message', this.handleSocketMessage.bind(this));

        this.status = 'disconnected';

        this.logger = new Logger(opts.logger, "connection");
        this.fileTransfers = new FileTransferManager(this);

        this.messageHandlers = {
            signalling: (message) => {
                let peer = this.getPeer(message.peerId);
                if (peer) {
                    peer.receiveSignallingMessage(message.payload);
                }
            },
            announce: (message) => {
                // when another peer joins
                let peer = this.addPeer(message.payload.peer, {isInitiator: false});
                this.emit('peerAnnounce', peer, message);
                this.attemptResumeFiletransfers(peer);
            },
            join: (message) => {
                // when the user connects
                this.selfPeerId = message.payload.self.peerId;
                for (let member of message.payload.members) {
                    if (member.peerId) {
                        let peer = this.addPeer(member, {isInitiator: true});
                        peer.start();
                        this.attemptResumeFiletransfers(peer);
                    }
                }
                this.emit('join', message.payload, message);
            },
            leave: (message) => {
                // when another peer leaves
                let peer = this.removePeer(message.payload.id);
                this.emit('peerLeave', peer, message);
            },
            event: (message) => {
                if (!this.selfPeerId || message.peerId != this.selfPeerId) {
                    this.emit(`event.${message.payload.type}`, message.payload.data, message);
                }
            }
        };
    }

    onConnect() {
        this.status = 'connected';
        this.emit('connect');
    }

    connect() {
        /**
         * Open the websocket and connect
         */
        if (this.status == 'disconnected') {
            this.status = 'connecting';
            this.socket.once('open', this.onConnect.bind(this));
            this.socket.open();
            this.emit('connecting');
        }
    }

    getMessages({until}) {
        let url;
        if (until) {
            url = `${this.urls.messages}?until=${until}`;
        }
        else {
            url = this.urls.messages;
        }
        return fetchJSON(url);
    }

    handleSocketMessage(message) {
        /**
         * Dispatches a message received from the socket.
         * @private
         * @param {obj} message: the received message
         */
        let msgData = Message.decode(message);
        msgData.room = this.room;

        // Camelize the payload and (if event) the event type too
        msgData.payload = camelizeKeys(msgData.payload);
        if (msgData.type == MESSAGE_TYPES.EVENT) {
            msgData.payload.type = camelize(msgData.payload.type);
        }

        message = new Message(msgData);
        this.messageHandlers[message.typeName](message);
        if (!this.selfPeerId || message.peerId != this.selfPeerId) {
            this.emit('message', message);
        }
    }

    addPeer(data, {isInitiator = false} = {}) {
        /**
         * Set up a peer
         * @param {obj} data: Info received from the server about the peer
         */
        let peer = new Peer({
            id: data.peerId,
            uid: data.uid,
            info: data.info,
            connection: this,
            logger: this.logger,
            isInitiator,
        });

        if (this.stream) {
            peer.addLocalStream(this.stream);
        }
        let existingPeer = this.getPeer(peer.id);
        if (existingPeer) {
            existingPeer = peer;
        }
        else {
            this.peers.push(peer);
        }
        peer.on('requestFileTransfer', data => this.emit('requestFileTransfer', peer, data));
        this.emit('peerAdded', peer);
        return peer;
    }

    initialJoin(data) {
        return fetchPost(this.urls.join, decamelizeKeys(data));
    }

    send({type, payload}, {http = true} = {}) {
        let decamelized = decamelizeKeys(payload);
        if (http) {
            return fetchPost(this.urls.messages, {
                type: type,
                payload: decamelized,
            });
        }
        else {
            this.socket.send({
                t: type,
                p: decamelized,
            });
        }
    }

    sendEvent(type, data, {http = true} = {}) {
        let toSend = {type: MESSAGE_TYPES.EVENT, payload: {
            type: decamelize(type),
            data: data
        }};
        return this.send(toSend, {http: http});
    }

    runAction(name, data) {
        return fetchPost(this.urls.action.replace(':name', decamelize(name)), decamelizeKeys(data));
    }

    connectStream(stream) {
        if (this.stream) {
            _.each(this.stream.getTracks(), t => t.stop());
        }
        this.stream = stream;
        for (let peer of this.peers) {
            peer.addLocalStream(this.stream);
        }
        this.emit('localStreamConnected');
    }

    getPeer(id) {
        return _.find(this.peers, p => p.id == id);
    }

    removePeer(id) {
        let peer = this.getPeer(id);
        peer.end();
        this.peers = _.reject(this.peers, p => p.id == id);
        this.emit('peerRemoved', {peerId: peer.id, uid: peer.uid});
        return peer;
    }

    notifyCreatedRecording(data) {
        return fetchPost(this.urls.recordings, decamelizeKeys(data));
    }

    requestFileTransfer(fileId, peer) {
        peer.sendSignallingMessage('requestFileTransfer', {fileId});
        peer.once('fileTransferChannelOpen', (channel) => {
            let receiver = this.fileTransfers.receiveFile({channel, peer, fileId, fs: this.fs});
            receiver.on('*', (name, ...args) => this.emit(`fileTransfer.${name}`, ...args));
        });
    }

    attemptResumeFiletransfers(peer) {
        let receivers = this.fileTransfers.receiversForUid(peer.uid);
        if (receivers) {
            for (let receiver of receivers) {
                this.requestFileTransfer(receiver.fileId, peer);
            }
        }
    }
}