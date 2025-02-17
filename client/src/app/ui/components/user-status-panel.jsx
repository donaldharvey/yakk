import React from 'react';
import {whyRun} from 'mobx';
import {observer} from "mobx-react";
import _ from 'lodash';
import {MEMBER_STATUSES, ROLES} from 'app/rooms/constants';
import {formatBytes} from '../helpers';
import {formatDuration} from 'lib/util';
import Button from './Button';
import { serverTimeNow } from 'lib/timesync';

@observer
export class RecordingButton extends React.Component {
    onStartClick() {
        if (this.props.membership.isSelf) {
            this.props.controller.startRecording();
        }
        else {
            this.props.controller.requestStartRecording(this.props.membership);
        }
    }
    onStopClick() {
        if (this.props.membership.isSelf) {
            this.props.controller.stopRecording();
        }
        else {
            this.props.controller.requestStopRecording(this.props.membership);
        }
    }
    render() {
        if (this.props.membership.recorderStatus == 'started') {
            return <Button className="recording stop" onClick={this.onStopClick.bind(this)}>Stop</Button>;
        }
        else {
            return <Button
                onClick={this.onStartClick.bind(this)}
                disabled={this.props.membership.recorderStatus != 'ready'}
                className="recording start"
            >
                Record
            </Button>;
        }
    }
}

@observer
export class RecordAllButton extends React.Component {
    startRecordingAllEnabled() {
        return _.some(this.connectedMemberships, (mem) => mem.recorderStatus == 'ready');
    }
    showStopRecordingAllButton() {
        return _.some(this.connectedMemberships, (mem) => mem.recorderStatus == 'started');
    }
    get connectedMemberships() {
        return this.props.room.memberships.connected;
    }
    onStartClick() {
        // move this calc out of UI component!
        let when = new Date(
            Math.round((+(serverTimeNow()) + 5000) / 1000) * 1000
        );
        console.log('Starting recording at', when);
        _.each(this.connectedMemberships, (mem) => {
            if (mem.recorderStatus == 'ready') {
                if (mem.isSelf) {
                    this.props.controller.startRecording({when});
                }
                else {
                    this.props.controller.requestStartRecording(mem, {when});
                }
            }
        });
    }
    onStopClick() {
        let when = serverTimeNow();
        _.each(this.connectedMemberships, (mem) => {
            if (mem.recorderStatus == 'started') {
                if (mem.isSelf) {
                    this.props.controller.stopRecording({when});
                }
                else {
                    this.props.controller.requestStopRecording(mem, {when});
                }
            }
        });
    }
    render() {
        return (
            this.showStopRecordingAllButton() ?
            <Button className="recording recording-all stop" onClick={() => this.onStopClick()}>Stop all</Button> :
            <Button className="recording recording-all start" disabled={!this.startRecordingAllEnabled()} onClick={() => this.onStartClick()}>Record Everyone</Button>
        );
    }
}


@observer
export class UserStatusPanelItem extends React.Component {
    getClassName() {
        let c = "";
        if (this.props.membership.status == MEMBER_STATUSES.CONNECTED) {
            c += 'connected';
        }
        else {
            c += 'disconnected';
        }
        return c;
    }
    getRecordingStatus() {
        if (this.props.membership.status == MEMBER_STATUSES.DISCONNECTED) {
            return 'offline';
        }
        switch (this.props.membership.recorderStatus) {
            case "ready":
                return "ready";
            case "started":
                return [
                    <span>Rec</span>,
                    " ",
                    <time datetime={`${this.props.membership.currentRecording.currentDuration}s`}>
                        {formatDuration(this.props.membership.currentRecording.currentDuration, {
                            format: "stopwatch"
                        })}
                    </time>
                ];
            case "stopping":
                return "stopping";
        }
    }
    getMinutesLeft() {
        return [Math.round(this.props.membership.approxMinutesLeft), ' minutes left'];
    }
    render() {
        let membership = this.props.membership;
        let canEditName = (this.props.room.memberships.self.role == ROLES.OWNER || membership.isSelf);
        return (
            <div className={`membership ${this.getClassName()}`}>
                <div className="topline">
                    <div className="info">
                        <span className={"name " + (canEditName ? "can-edit" : "")}>
                            <span>{membership.name}</span>
                            {canEditName && (
                                <Button className="edit btn-small with-tooltip" onClick={() => this.props.uiStore.showEditNameModal(membership)} aria-label="Edit name">
                                    <i className="fa fa-pencil sr-hidden" />
                                    <span className="sr-only">Edit</span>
                                </Button>
                            )}
                        </span>
                        {" "}
                        { membership.role == 'o' && <span className="with-tooltip" aria-label="Host"><i className="fa fa-star" style={{color: 'gold'}} /></span>}
                        {" "}
                        {
                            (
                                membership.status != MEMBER_STATUSES.DISCONNECTED &&
                                membership.peerStatus
                            ) &&
                            <span className={`peer-status`}>
                                {
                                    membership.peerStatus == "connected" ?
                                    <span className="with-tooltip" aria-label="P2P connection established"><i className="fa fa-plug" aria-hidden="true"></i></span>:
                                    null
                                }
                            </span>
                        }
                        {" "}
                        {
                            (
                                membership.status != MEMBER_STATUSES.DISCONNECTED &&
                                membership.resources
                            ) ?
                            <div className="resources">
                                <span
                                    className={`video with-tooltip ${membership.resources.video ? '' : 'disabled'}`}
                                    aria-label={(
                                        (
                                            membership.resources.video &&
                                            membership.resources.video.width
                                        ) ?
                                        `Video available (${membership.resources.video.width} x ${membership.resources.video.height})` :
                                        `Video unavailable`
                                    )}>
                                    {
                                        membership.resources.video &&
                                        membership.resources.video.width ?
                                        <i
                                            className="fa fa-video-camera"
                                            aria-hidden="true"
                                        ></i> :
                                        null
                                    }
                                </span>{" "}
                                <span
                                    className={`audio with-tooltip ${membership.resources.audio ? '' : 'disabled'}`}
                                    aria-label={membership.resources.audio ? "Audio available" : "Audio unavailable"}
                                >
                                    {membership.resources.audio && <i
                                        className="fa fa-microphone"
                                        aria-hidden="true"
                                    ></i>}
                                </span>
                            </div> :
                            null
                        }
                    </div>
                    <div className="recording-status">
                        {this.getRecordingStatus()}
                    </div>
                </div>
                {
                    membership.diskUsage ?
                    <div className="disk">
                        <div className="bar">
                            <span style={{width: (100*membership.diskUsage.usage/membership.diskUsage.quota)+"%" }} />
                        </div>
                        <div className="info">
                            <div className="time-left">
                                {this.getMinutesLeft()}
                            </div>
                            <div className="usage-info">
                                {formatBytes(membership.diskUsage.usage)} / {formatBytes(membership.diskUsage.quota)}
                            </div>
                        </div>
                    </div> :
                    null
                }
                {
                    membership.resources &&
                    <div className="recording">
                        {membership.currentRecording && <div className="status">
                            <span className="size">{formatBytes(membership.currentRecording.filesize || 0)}</span>
                            {" "}
                            <span className="bitrate">{formatBytes(membership.currentRecording.bitrate || 0)}/s</span>
                        </div>}
                        {this.props.self.role == ROLES.OWNER && (
                            <RecordingButton {...this.props} membership={membership} />
                        )}
                    </div>
                }
            </div>
        );
    }
}

@observer
export default class UserStatusPanel extends React.Component {
    render() {
        return (
            <div className="panel user-status-panel">
                <ul>
                    {_.map(this.props.room.memberships.values().slice(), (membership) => (
                        <li key={membership.uid}>
                            <UserStatusPanelItem {...this.props} membership={membership} />
                        </li>
                    ))}
                </ul>
                {this.props.self.role == ROLES.OWNER && (
                    <div><RecordAllButton {...this.props} /></div>
                )}
            </div>
        );
    }
}