/**
 * 日報ハブ — トリガーから呼ばれる処理。
 *
 * handleFormSubmit  … フォームの回答を受けて日報シートへ記録し、要対応なら本部へ通知
 * remindMissing     … 毎日、締め時刻に未提出の店舗へリマインド
 * sendWeeklySummary … 毎週月曜に前週のまとめを週次集計シートへ書き、本部へ送る
 */

function handleFormSubmit(e) {
  var lock = LockService.getScriptLock();
  // 同時に複数の回答が届いても、同じ行を二重に書かないよう順番に処理する。
  if (!lock.tryLock(30 * 1000)) throw new Error('ほかの処理が終わらないため、受付を中断しました');
  try {
    var answers = flattenAnswers_(e.namedValues);
    var stores = loadStores_();
    var result = normalizeReport(answers, stores);
    if (result.errors.length) {
      logError_(answers[FORM_FIELDS.store], answers[FORM_FIELDS.date], result.errors);
      return;
    }

    var report = result.report;
    var config = getConfig_();
    var reasons = attentionReasons(report, config.thresholds);
    var saved = upsertReport_(report, reasons);

    if (reasons.length) {
      var subject = '【要対応】' + report.storeName + ' ' + report.date + (saved.updated ? '（修正）' : '');
      var html = '<p>' + escapeHtml(report.storeName) + ' の ' + escapeHtml(report.date) + ' の日報に、確認が必要な内容があります。</p>' +
        '<ul>' + reasons.map(function (r) { return '<li>' + escapeHtml(r) + '</li>'; }).join('') + '</ul>' +
        (report.note ? '<p>連絡事項：' + escapeHtml(report.note) + '</p>' : '');
      sendMail_('要対応', config.hqEmail, subject, html);
    }
  } finally {
    lock.releaseLock();
  }
}

/** namedValues は質問ごとに配列で届くので、先頭の値だけにする。 */
function flattenAnswers_(namedValues) {
  var out = {};
  Object.keys(namedValues || {}).forEach(function (k) {
    var v = namedValues[k];
    out[k] = Array.isArray(v) ? v[0] : v;
  });
  return out;
}

function remindMissing() {
  var date = today_();
  var stores = loadStores_();
  var keys = loadReports_().map(function (r) { return r.key; });
  var missing = findMissingStores(stores, keys, date);

  missing.forEach(function (store) {
    sendMail_('リマインド', store.email, '【日報】' + date + ' の日報が未提出です',
      '<p>' + escapeHtml(store.name) + ' ご担当者さま</p>' +
      '<p>' + escapeHtml(date) + ' の日報がまだ届いていません。本日中の送信をお願いします。</p>');
  });

  if (missing.length) {
    var config = getConfig_();
    sendMail_('未提出の一覧', config.hqEmail, '【日報】' + date + ' 未提出 ' + missing.length + '店舗',
      '<p>締め時刻の時点で、次の店舗の日報が届いていません。</p><ul>' +
      missing.map(function (s) { return '<li>' + escapeHtml(s.name) + '</li>'; }).join('') + '</ul>');
  }
  return missing.length;
}

function sendWeeklySummary() {
  var week = previousWeek(today_());
  var summary = summarizeWeek(loadStores_(), loadReports_(), week);
  writeWeekly_(summary);
  var config = getConfig_();
  sendMail_('週次まとめ', config.hqEmail, '【日報】週次まとめ ' + week.start + '〜' + week.end, renderWeeklyHtml(summary));
  return summary;
}

/** 同じ週の行があれば消してから書き直す。何度実行しても結果は同じになる。 */
function writeWeekly_(summary) {
  var sh = sheet_('weekly');
  var label = summary.week.start + '〜' + summary.week.end;
  for (var row = sh.getLastRow(); row >= 2; row--) {
    if (String(sh.getRange(row, 1).getValue()) === label) sh.deleteRow(row);
  }
  var created = now_();
  var values = summary.rows.map(function (r) {
    return [label, r.storeId, sanitizeCell(r.storeName), r.openDays, r.submitted,
      Math.round(r.submitRate * 1000) / 1000, r.served, Math.round(r.leftoverRate * 1000) / 1000, r.attention, created];
  });
  if (values.length) {
    sh.getRange(sh.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
  }
}
