import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedEnvironment, permissionProfile, assessProbe } from '../scripts/check-codex-profile.mjs';

test('fixture environment is a whitelist with isolated user and Codex homes', () => {
  const env = isolatedEnvironment('/private/tmp/fixture');
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME','HOME','LANG','PATH','TMPDIR']);
  assert.equal(env.HOME,'/private/tmp/fixture/home');
  assert.equal(env.CODEX_HOME,'/private/tmp/fixture/codex');
  assert.equal(env.TMPDIR,'/private/tmp/fixture/tmp');
});

test('named permissions grant explicit runtime reads and fixture writes without broad platform defaults', () => {
  const config = permissionProfile('/private/tmp/fixture/inside');
  assert.match(config,/default_permissions = "fixture"/);
  assert.match(config,/\[permissions.fixture.filesystem\]/);
  assert.match(config,/"\/System\/Library" = "read"/);
  assert.match(config,/"\/private\/tmp\/fixture\/inside" = "write"/);
  assert.match(config,/\[permissions.fixture.network\]\nenabled = false/);
  assert.match(config,/":root" = "deny"/);
  assert.match(config,/":tmpdir" = "deny"/);
  assert.match(config,/":slash_tmp" = "deny"/);
  assert.doesNotMatch(config,/:minimal|extends|sandbox_mode|sandbox_workspace_write/);
});

const denied = {allowed:false,errno:1};
function passingProbe() {
  return { insideRead:{allowed:true,errno:0}, insideCreate:{allowed:true,errno:0},
    outsideRead:denied,outsideCreate:denied,symlinkRead:denied,symlinkCreate:denied,
    createOutsideHardlink:denied,loopbackNetwork:denied };
}

test('boundary assessment requires positive controls and actual permission errors', () => {
  assert.equal(assessProbe(passingProbe()).restrictedBoundary,true);
  assert.equal(assessProbe({...passingProbe(),insideRead:denied}).restrictedBoundary,false);
  assert.equal(assessProbe({...passingProbe(),outsideRead:{allowed:false,errno:2}}).restrictedBoundary,false);
  assert.equal(assessProbe({...passingProbe(),loopbackNetwork:{allowed:false,errno:61}}).restrictedBoundary,false);
  assert.equal(assessProbe({...passingProbe(),outsideCreate:{allowed:true,errno:0}}).restrictedBoundary,false);
});

test('platform-defaults comparison must be explicitly selected', () => {
  assert.doesNotMatch(permissionProfile('/private/tmp/fixture/inside'),/":minimal"/);
  assert.match(permissionProfile('/private/tmp/fixture/inside',{platformDefaults:true}),/":minimal" = "read"/);
});
