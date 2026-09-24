// Unit tests for the browser task-notification bridge in web/zcode-bridge.js.
// Usage: node scripts/dev/notification-bridge-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/zcode-bridge.js', import.meta.url), 'utf8');
const listeners = new Map();
const notifications = [];
let permissionRequests = 0;

class FakeNotification {
  static permission = 'default';
  static requestPermission() {
    permissionRequests++;
    this.permission = 'granted';
    return Promise.resolve('granted');
  }
  constructor(title, options) {
    this.title = title;
    this.options = options;
    notifications.push(this);
  }
  close() { this.closed = true; }
}

const document = {
  visibilityState: 'hidden',
  hasFocus: () => false,
  addEventListener(type, fn) { listeners.set(type, fn); },
  head: { appendChild() {} },
  body: { appendChild() {} },
};
const window = {
  __ZCODE_WEBUI_CONFIG__: {},
  document,
  location: { pathname: '/' },
  Notification: FakeNotification,
  addEventListener() {},
  focus() {},
  open() {},
  setTimeout,
  clearTimeout,
};
const sandbox = {
  window,
  document,
  Notification: FakeNotification,
  localStorage: { getItem() { return null; }, setItem() {} },
  fetch() { return Promise.reject(new Error('unexpected fetch')); },
  setTimeout,
  clearTimeout,
  console,
  URL,
};
vm.runInNewContext(source, sandbox, { filename: 'web/zcode-bridge.js' });

assert.equal(permissionRequests, 0, 'permission is not requested during bridge initialization');
listeners.get('click')();
assert.equal(permissionRequests, 1, 'permission is requested from a user gesture');

let clickedTaskId;
const unsubscribe = window.zcode.onTaskNotificationClick((taskId) => { clickedTaskId = taskId; });
window.zcode.showTaskNotification({ taskId: 'task-1', status: 'failed', body: 'boom' });
assert.equal(notifications.length, 1);
assert.equal(notifications[0].title, 'ZCode 任务失败');
assert.equal(notifications[0].options.body, 'boom');
assert.equal(notifications[0].options.tag, 'zcode-task-task-1');
assert.equal(notifications[0].options.requireInteraction, true);
notifications[0].onclick();
assert.equal(clickedTaskId, 'task-1');
assert.equal(notifications[0].closed, true);

document.visibilityState = 'visible';
document.hasFocus = () => true;
window.zcode.showTaskNotification({ taskId: 'task-2', status: 'completed' });
assert.equal(notifications.length, 1, 'foreground task completion is suppressed');
unsubscribe();
notifications[0].onclick();
assert.equal(clickedTaskId, 'task-1', 'unsubscribe stops later click callbacks');

console.log('notification bridge checks passed');
