import assert from 'node:assert/strict';
import test from 'node:test';
import { customerBotCommands, staffBotCommands } from '../src/bot/commands.js';
import { ALL_PERMISSIONS } from '../src/domain/logic.js';

test('customer command menu is minimal', () => {
  const names = customerBotCommands().map((c) => c.command);
  assert.deepEqual(names, ['start', 'cancel']);
});

test('staff command menu reflects permissions', () => {
  const limited = {
    isOwner: false,
    isStaff: true,
    allow(key) { return key === 'lookup'; }
  };
  const names = staffBotCommands(limited).map((c) => c.command);
  assert.ok(names.includes('openlines'));
  assert.ok(!names.includes('excel'));
  assert.ok(!names.includes('addowner'));

  const owner = {
    isOwner: true,
    isStaff: true,
    allow() { return true; }
  };
  const ownerNames = staffBotCommands(owner).map((c) => c.command);
  assert.ok(ownerNames.includes('addowner'));
  assert.ok(ownerNames.includes('excel'));
});

test('full admin gets invoice commands', () => {
  const admin = {
    isOwner: false,
    isStaff: true,
    allow(key) { return ALL_PERMISSIONS[key] === true; }
  };
  const names = staffBotCommands(admin).map((c) => c.command);
  assert.ok(names.includes('invoices'));
  assert.ok(!names.includes('addowner'));
});
