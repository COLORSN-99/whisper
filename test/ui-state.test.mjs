import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateSyncGuard} from '../public/ui-state.js';

test('bootstrap does not overwrite a task terminal state received by SSE while fetching', () => {
  const guard = createStateSyncGuard();
  const request = guard.beginSnapshot();
  const liveState = {tasks: [{id:'task-1',status:'failed'}]};
  guard.noteEvent(['tasks']);
  Object.assign(liveState, guard.acceptSnapshot({
    tasks: [{id:'task-1',status:'running'}],
    csrf: 'current-session-token',
    providers: [{id:'demo'}],
  }, request));
  assert.equal(liveState.tasks[0].status, 'failed');
  assert.equal(liveState.csrf, 'current-session-token');
  assert.deepEqual(liveState.providers, [{id:'demo'}]);
});

test('in-flight bootstrap preserves streamed messages and authentication events', () => {
  const guard = createStateSyncGuard();
  const request = guard.beginSnapshot();
  guard.noteEvent(['conversations']);
  guard.noteEvent(['auth']);
  assert.deepEqual(guard.acceptSnapshot({
    conversations: [{messages:[{content:'partial'}]}],
    auth: {connected:false},
    workspace: '/app/workspace',
  }, request), {workspace:'/app/workspace'});
});

test('late older snapshots cannot roll back a newer accepted snapshot', () => {
  const guard = createStateSyncGuard();
  const older = guard.beginSnapshot();
  const newer = guard.beginSnapshot();
  assert.deepEqual(guard.acceptSnapshot({tasks:['completed']}, newer), {tasks:['completed']});
  assert.equal(guard.acceptSnapshot({tasks:['running']}, older), null);
});

test('a snapshot started after an event may refresh that field', () => {
  const guard = createStateSyncGuard();
  guard.noteEvent(['tasks']);
  const request = guard.beginSnapshot();
  assert.deepEqual(guard.acceptSnapshot({tasks:['completed']}, request), {tasks:['completed']});
});
