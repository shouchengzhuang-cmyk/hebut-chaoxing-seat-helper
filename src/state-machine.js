export const SeatState = Object.freeze({
  IDLE: 'IDLE', PROBING: 'PROBING', READY: 'READY', ARMED: 'ARMED',
  WAITING_FOR_OPEN: 'WAITING_FOR_OPEN', WAITING_FOR_GATE_RELEASE: 'WAITING_FOR_GATE_RELEASE',
  LOADING_TARGET_DAY: 'LOADING_TARGET_DAY', TARGET_READY: 'TARGET_READY', FIRING: 'FIRING', VERIFYING: 'VERIFYING', SUCCESS: 'SUCCESS',
  NEEDS_HUMAN: 'NEEDS_HUMAN', SESSION_EXPIRED: 'SESSION_EXPIRED', MISSED_WINDOW: 'MISSED_WINDOW', STOPPED: 'STOPPED', ERROR: 'ERROR'
});

const transitions = Object.freeze({
  IDLE: ['PROBING', 'READY', 'STOPPED', 'ERROR'],
  PROBING: ['READY', 'NEEDS_HUMAN', 'SESSION_EXPIRED', 'STOPPED', 'ERROR'],
  READY: ['PROBING', 'ARMED', 'MISSED_WINDOW', 'STOPPED', 'ERROR'],
  ARMED: ['WAITING_FOR_OPEN', 'LOADING_TARGET_DAY', 'MISSED_WINDOW', 'STOPPED', 'ERROR'],
  WAITING_FOR_OPEN: ['LOADING_TARGET_DAY', 'MISSED_WINDOW', 'STOPPED', 'ERROR'],
  WAITING_FOR_GATE_RELEASE: ['LOADING_TARGET_DAY', 'NEEDS_HUMAN', 'STOPPED', 'ERROR'],
  LOADING_TARGET_DAY: ['TARGET_READY', 'WAITING_FOR_GATE_RELEASE', 'SESSION_EXPIRED', 'STOPPED', 'ERROR'],
  TARGET_READY: ['FIRING', 'STOPPED', 'ERROR'],
  FIRING: ['VERIFYING', 'NEEDS_HUMAN', 'SESSION_EXPIRED', 'STOPPED', 'ERROR'],
  VERIFYING: ['SUCCESS', 'WAITING_FOR_GATE_RELEASE', 'FIRING', 'NEEDS_HUMAN', 'SESSION_EXPIRED', 'STOPPED', 'ERROR'],
  SUCCESS: [], NEEDS_HUMAN: ['SUCCESS', 'STOPPED', 'ERROR'], SESSION_EXPIRED: ['PROBING', 'STOPPED'],
  MISSED_WINDOW: ['PROBING', 'STOPPED'], STOPPED: ['PROBING', 'READY', 'ARMED'], ERROR: ['PROBING', 'STOPPED']
});

export class SeatStateMachine {
  constructor(initial = SeatState.IDLE, onTransition = () => {}) {
    this.state = initial;
    this.history = [{ from: null, to: initial, at: Date.now(), reason: 'initial' }];
    this.onTransition = onTransition;
  }
  can(to) { return transitions[this.state]?.includes(to) ?? false; }
  transition(to, reason = '') {
    if (!this.can(to)) throw new Error(`Illegal seat state transition: ${this.state} -> ${to}`);
    const event = { from: this.state, to, at: Date.now(), reason };
    this.state = to;
    this.history.push(event);
    this.onTransition(event);
    return event;
  }
  isTerminal() { return transitions[this.state]?.length === 0; }
}
