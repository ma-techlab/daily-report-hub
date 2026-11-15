const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readConfig(values) {
  const context = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => Object.hasOwn(values, key) ? values[key] : null,
      }),
    },
  });
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Store.js'), 'utf8');
  vm.runInContext(src, context);
  return context.getConfig_();
}

test('設定：有効な時刻と閾値を読み込む', () => {
  const config = readConfig({
    HQ_EMAIL: 'hq@example.com', DRY_RUN: 'false', REMIND_HOUR: '16', WEEKLY_HOUR: '9',
    LEFTOVER_ALERT_RATE: '0.2', SHORTAGE_ALERT_RATE: '0.05',
  });
  assert.equal(config.hqEmail, 'hq@example.com');
  assert.equal(config.dryRun, false);
  assert.equal(config.remindHour, 16);
  assert.equal(config.weeklyHour, 9);
  assert.equal(config.thresholds.leftoverRate, 0.2);
  assert.equal(config.thresholds.shortageRate, 0.05);
});

test('設定：範囲外・小数の時刻・空文字は安全な既定値に戻す', () => {
  const config = readConfig({
    REMIND_HOUR: '24', WEEKLY_HOUR: '8.5', LEFTOVER_ALERT_RATE: '-0.1', SHORTAGE_ALERT_RATE: '',
  });
  assert.equal(config.remindHour, 15);
  assert.equal(config.weeklyHour, 8);
  assert.equal(config.thresholds.leftoverRate, 0.15);
  assert.equal(config.thresholds.shortageRate, 0.1);
});
