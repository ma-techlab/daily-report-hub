const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/Logic.js');

const F = L.FORM_FIELDS;
const stores = [
  { id: 'S01', name: '本町店', email: 'a@example.com', closedWeekdays: ['日'], active: true },
  { id: 'S02', name: '北工場', email: 'b@example.com', closedWeekdays: ['土', '日'], active: true },
  { id: 'S09', name: '閉店', email: '', closedWeekdays: [], active: false },
];
const thresholds = { leftoverRate: 0.15, shortageRate: 0.1 };

function answers(overrides = {}) {
  return {
    [F.store]: '本町店', [F.date]: '2026/11/2', [F.planned]: '200', [F.served]: '190',
    [F.leftover]: '10', [F.staff]: '6', [F.hygiene]: L.HYGIENE_OK, [F.consult]: L.CONSULT_NO,
    [F.note]: '', ...overrides,
  };
}

test('日付：ゼロ埋めなし・スラッシュ区切りをそろえ、存在しない日付は弾く', () => {
  assert.equal(L.normalizeDate('2026/11/2'), '2026-11-02');
  assert.equal(L.normalizeDate('2026-11-02'), '2026-11-02');
  assert.equal(L.isDateString('2026-02-30'), false);
  assert.equal(L.isDateString('2028-02-29'), true);
});

test('曜日と前週：月曜でも日曜でも、締まった前の週（月〜日）を返す', () => {
  assert.equal(L.weekdayOf('2026-11-02'), 1); // 月曜
  assert.deepEqual(L.previousWeek('2026-11-02'), { start: '2026-10-26', end: '2026-11-01' });
  assert.deepEqual(L.previousWeek('2026-11-08'), { start: '2026-10-26', end: '2026-11-01' });
  assert.deepEqual(L.previousWeek('2026-11-09'), { start: '2026-11-02', end: '2026-11-08' });
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
});

test('定休曜日：表記ゆれを吸収し、曜日以外は無視する', () => {
  assert.deepEqual(L.parseClosedWeekdays('土,日'), ['土', '日']);
  assert.deepEqual(L.parseClosedWeekdays('土曜日、日曜'), ['土', '日']);
  assert.deepEqual(L.parseClosedWeekdays('祝日 日'), ['日']);
  assert.deepEqual(L.parseClosedWeekdays(''), []);
});

test('店舗マスタ：店舗IDと店舗名の空欄・重複を検出する', () => {
  assert.deepEqual(L.storeMasterErrors(stores), []);
  const errors = L.storeMasterErrors([
    { id: 'S01', name: '本町店' },
    { id: 'S01', name: '港店' },
    { id: 'S03', name: '本町店' },
    { id: '', name: '' },
  ]);
  assert.match(errors.join('\n'), /店舗IDが重複/);
  assert.match(errors.join('\n'), /店舗名が重複/);
  assert.match(errors.join('\n'), /店舗IDが空/);
  assert.match(errors.join('\n'), /店舗名が空/);
});

test('回答の整形：正しい回答は店舗IDに置き換えて受け付ける', () => {
  const { errors, report } = L.normalizeReport(answers(), stores);
  assert.deepEqual(errors, []);
  assert.equal(report.storeId, 'S01');
  assert.equal(report.date, '2026-11-02');
  assert.equal(report.served, 190);
  assert.equal(report.hygieneOk, true);
  assert.equal(report.consult, false);
});

test('回答の整形：マスタにない店舗・小数・負の数・残食の超過を理由つきで弾く', () => {
  const r = L.normalizeReport(answers({ [F.store]: '架空店', [F.served]: '10.5', [F.staff]: '-1' }), stores);
  assert.equal(r.errors.length, 3);
  assert.match(r.errors[0], /店舗マスタにない/);

  const over = L.normalizeReport(answers({ [F.served]: '50', [F.leftover]: '60' }), stores);
  assert.deepEqual(over.errors, ['残食数が提供食数を上回っています']);
});

test('回答の整形：無効店舗・不明な選択肢・安全に扱えない大きな整数を弾く', () => {
  const inactive = L.normalizeReport(answers({ [F.store]: '閉店' }), stores);
  assert.match(inactive.errors.join('\n'), /無効な店舗/);

  const choices = L.normalizeReport(answers({ [F.hygiene]: '', [F.consult]: '不明' }), stores);
  assert.match(choices.errors.join('\n'), /衛生点検の選択内容/);
  assert.match(choices.errors.join('\n'), /本部への相談の選択内容/);

  const huge = L.normalizeReport(answers({ [F.planned]: '9007199254740992' }), stores);
  assert.match(huge.errors.join('\n'), /予定食数は0以上の整数/);
});

test('要対応：問題がなければ理由は空', () => {
  const { report } = L.normalizeReport(answers(), stores);
  assert.deepEqual(L.attentionReasons(report, thresholds), []);
});

test('要対応：衛生点検・相談・残食率・提供不足をそれぞれ理由にする', () => {
  const { report } = L.normalizeReport(answers({
    [F.hygiene]: L.HYGIENE_NG, [F.consult]: L.CONSULT_YES, [F.served]: '150', [F.leftover]: '30',
  }), stores);
  const reasons = L.attentionReasons(report, thresholds);
  assert.equal(reasons.length, 4);
  assert.match(reasons[2], /残食率が20\.0%/);
  assert.match(reasons[3], /50食少ない/);
});

test('要対応：基準ちょうどは通知しない（超えたときだけ）', () => {
  const report = { served: 100, leftover: 15, planned: 100, hygieneOk: true, consult: false };
  assert.deepEqual(L.attentionReasons(report, thresholds), []);
  const zero = { served: 0, leftover: 0, planned: 0, hygieneOk: true, consult: false };
  assert.deepEqual(L.attentionReasons(zero, thresholds), []);
});

test('未提出：営業日で日報がない店舗だけ。定休日と無効な店舗は含めない', () => {
  const keys = [L.reportKey('S01', '2026-11-02')];
  assert.deepEqual(L.findMissingStores(stores, keys, '2026-11-02').map((s) => s.id), ['S02']);
  // 土曜：北工場は定休
  assert.deepEqual(L.findMissingStores(stores, [], '2026-11-07').map((s) => s.id), ['S01']);
  // 日曜：両店とも定休
  assert.deepEqual(L.findMissingStores(stores, [], '2026-11-08'), []);
});

test('週次集計：提出率は定休日を除いた営業日が分母。週の外の日報は数えない', () => {
  const week = { start: '2026-10-26', end: '2026-11-01' };
  const reports = [
    { storeId: 'S01', date: '2026-10-26', served: 100, leftover: 10, attention: false },
    { storeId: 'S01', date: '2026-10-27', served: 100, leftover: 20, attention: true },
    { storeId: 'S02', date: '2026-10-30', served: 200, leftover: 10, attention: false },
    { storeId: 'S01', date: '2026-11-02', served: 999, leftover: 999, attention: true },
  ];
  const s = L.summarizeWeek(stores, reports, week);
  assert.deepEqual(s.rows.map((r) => r.storeId), ['S01', 'S02']);
  const [a, b] = s.rows;
  assert.equal(a.openDays, 6);
  assert.equal(a.submitted, 2);
  assert.equal(a.served, 200);
  assert.equal(a.leftoverRate, 0.15);
  assert.equal(a.attention, 1);
  assert.equal(b.openDays, 5);
  assert.equal(b.submitRate, 0.2);
  assert.equal(s.total.openDays, 11);
  assert.equal(s.total.submitted, 3);
  assert.equal(s.total.served, 400);
  assert.equal(s.total.leftoverRate, 40 / 400);
});

test('週次集計：定休日の日報は提出数と集計値に含めない', () => {
  const week = { start: '2026-11-02', end: '2026-11-08' };
  const reports = [
    { storeId: 'S01', date: '2026-11-02', served: 100, leftover: 10, attention: false },
    { storeId: 'S01', date: '2026-11-08', served: 999, leftover: 999, attention: true },
  ];
  const row = L.summarizeWeek(stores, reports, week).rows[0];
  assert.equal(row.openDays, 6);
  assert.equal(row.submitted, 1);
  assert.equal(row.served, 100);
  assert.equal(row.leftoverRate, 0.1);
  assert.equal(row.attention, 0);
});

test('メール本文：店舗名などの値をエスケープする', () => {
  const s = L.summarizeWeek(
    [{ id: 'X', name: '<script>alert(1)</script>', closedWeekdays: [], active: true }],
    [], { start: '2026-10-26', end: '2026-11-01' });
  const html = L.renderWeeklyHtml(s);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('セルの無害化：数式として実行される先頭記号だけを無効にする', () => {
  assert.equal(L.sanitizeCell('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.equal(L.sanitizeCell('-5食'), "'-5食");
  assert.equal(L.sanitizeCell('通常どおり'), '通常どおり');
  assert.equal(L.sanitizeCell(null), '');
});
