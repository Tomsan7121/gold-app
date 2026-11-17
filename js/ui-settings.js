// 設定画面と、チャートの「指標」「水準」シート
import * as store from './store.js';
import { DEFAULT_WEIGHTS, INDICATOR_NAMES } from './signals.js';
import { parseNum, checkRule, ruleFor, ruleText } from './validate.js';
import { $, el, clear, toast } from './dom.js';

const getPath = (o, p) => p.split('.').reduce((a, k) => (a ? a[k] : undefined), o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

// ---------------- 指標シート ----------------
const IND_DEFS = [
  { key: null, name: '判定・クロス用の移動平均', fields: [['params.emaFast', '短期EMA', 'int'], ['params.emaSlow', '長期EMA', 'int'], ['params.smaLong', '長期SMA', 'int']] },
  { key: 'sma', name: 'SMA（単純移動平均）', fields: [['ind.sma.periods', '期間（カンマ区切り）', 'text']] },
  { key: 'ema', name: 'EMA（指数移動平均）', fields: [['ind.ema.periods', '期間（カンマ区切り）', 'text']] },
  { key: 'bb', name: 'ボリンジャーバンド', fields: [['params.bbPeriod', '期間', 'int'], ['params.bbMult', 'σ', 'float']] },
  { key: 'ichimoku', name: '一目均衡表', fields: [['params.ichiTenkan', '転換', 'int'], ['params.ichiKijun', '基準', 'int'], ['params.ichiSenkouB', '先行B', 'int'], ['params.ichiDisp', 'ずらし', 'int']] },
  { key: 'psar', name: 'パラボリック SAR', fields: [['params.psarStart', '開始', 'float'], ['params.psarStep', '加速', 'float'], ['params.psarMax', '上限', 'float']] },
  { key: 'supertrend', name: 'スーパートレンド', fields: [['params.stPeriod', 'ATR期間', 'int'], ['params.stMult', '倍率', 'float']] },
  { key: 'keltner', name: 'ケルトナーチャネル', fields: [['params.kcEma', 'EMA', 'int'], ['params.kcAtr', 'ATR', 'int'], ['params.kcMult', '倍率', 'float']] },
  { key: 'vwap', name: 'VWAP（日中足のみ）', fields: [['params.vwapReset', 'リセット(UTC時)', 'int0']] },
  { key: 'volume', name: '出来高（先物）', fields: [] },
  { key: 'rsi', name: 'RSI', fields: [['params.rsi', '期間', 'int']] },
  { key: 'macd', name: 'MACD', fields: [['params.macdFast', '短期', 'int'], ['params.macdSlow', '長期', 'int'], ['params.macdSignal', 'シグナル', 'int']] },
  { key: 'stoch', name: 'ストキャスティクス', fields: [['params.stochK', '%K', 'int'], ['params.stochSmooth', '平滑', 'int'], ['params.stochD', '%D', 'int']] },
  { key: 'adx', name: 'ADX / DMI', fields: [['params.adx', '期間', 'int']] },
  { key: 'atr', name: 'ATR', fields: [['params.atr', '期間', 'int']] },
  { key: 'cci', name: 'CCI', fields: [['params.cci', '期間', 'int']] },
  { key: 'willr', name: 'ウィリアムズ%R', fields: [['params.willr', '期間', 'int']] },
  { key: 'roc', name: 'ROC', fields: [['params.roc', '期間', 'int']] },
  { key: 'mom', name: 'モメンタム', fields: [['params.mom', '期間', 'int']] },
  { key: 'hv', name: 'ヒストリカル・ボラティリティ', fields: [['params.hv', '期間', 'int']] },
];

// 13-5 の範囲表で検査する。範囲外は null（元の値に戻して範囲を示す）
function parseField(path, raw) {
  const rule = ruleFor(path);
  if (!rule) return null;
  const v = rule.t === 'periods' || rule.t === 'rr' ? String(raw) : parseNum(String(raw));
  if (v === null) return null;
  const [ok, norm] = checkRule(rule, v);
  return ok ? norm : null;
}
// 項目どうしの条件（短期 < 長期など）
function crossOk(S) {
  const P = S.params;
  return S.minLot <= S.maxLot && P.emaFast < P.emaSlow && P.macdFast < P.macdSlow && P.psarStart <= P.psarMax;
}

let changeTimer = null;
function changed(ctx) {
  ctx.save();
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => ctx.rerender(), 250);
}

function switchEl(checked, onchange) {
  return el('input', { type: 'checkbox', class: 'switch', checked, onchange: (e) => onchange(e.target.checked) });
}

function buildIndicatorSheet(ctx) {
  const box = clear($('#indForm'));
  box.appendChild(el('p', { class: 'small', text: 'チャートに表示する指標を選び、パラメータを変更できます。下のペイン（RSI 等）は増やすとチャートが縦に長くなります。' }));
  for (const d of IND_DEFS) {
    const r = el('div', { class: 'ind-row' }, el('div', { text: d.name }));
    if (d.key) r.appendChild(switchEl(ctx.settings.ind[d.key].on, (v) => { ctx.settings.ind[d.key].on = v; changed(ctx); }));
    else r.appendChild(el('span'));
    if (d.fields.length) {
      const ps = el('div', { class: 'params' });
      for (const [path, label, type] of d.fields) {
        const inp = el('input', { class: type === 'text' ? 'wide' : '', inputmode: type === 'text' ? 'text' : 'decimal', value: String(getPath(ctx.settings, path)) });
        inp.addEventListener('change', () => {
          const v = parseField(path, inp.value);
          const old = getPath(ctx.settings, path);
          if (v === null) { inp.value = String(old); toast(type === 'text' ? '1〜1000 の整数をカンマ区切りで入れてください' : ruleText(ruleFor(path))); return; }
          setPath(ctx.settings, path, v);
          if (!crossOk(ctx.settings)) { setPath(ctx.settings, path, old); inp.value = String(old); toast('短期の期間は長期より小さく、SAR の開始は上限以下にしてください'); return; }
          inp.value = String(v);
          changed(ctx);
        });
        ps.appendChild(el('label', {}, label, inp));
      }
      r.appendChild(ps);
    }
    box.appendChild(r);
  }
}

function buildLevelSheet(ctx) {
  const box = clear($('#lvForm'));
  const S = ctx.settings;
  const toggle = (label, obj, key) => box.appendChild(el('div', { class: 'ind-row' }, el('div', { text: label }), switchEl(!!obj[key], (v) => { obj[key] = v; changed(ctx); })));
  const select = (label, obj, key, opts, after) => {
    const s = el('select', { onchange: (e) => { obj[key] = typeof obj[key] === 'number' ? Number(e.target.value) : e.target.value; changed(ctx); if (after) after(); } },
      ...opts.map(([v, t]) => el('option', { value: String(v), text: t, selected: String(obj[key]) === String(v) })));
    box.appendChild(el('div', { class: 'ind-row' }, el('div', { text: label }), s));
  };
  box.appendChild(el('h4', { text: '水準ライン' }));
  toggle('ピボット（前日）', S.levels, 'pivot');
  select('ピボットの種類', S.levels, 'pivotMethod', [['classic', 'クラシック'], ['fibonacci', 'フィボナッチ'], ['camarilla', 'カマリラ']]);
  toggle('前日の高値・安値', S.levels, 'prevDay');
  toggle('前日終値', S.levels, 'prevClose');
  toggle('前週の高値・安値', S.levels, 'prevWeek');
  toggle('前月の高値・安値', S.levels, 'prevMonth');
  toggle('ラウンドナンバー', S.levels, 'round');
  select('ラウンドナンバーの間隔', S.levels, 'roundStep', [[50, '$50'], [100, '$100'], [25, '$25'], [10, '$10']]);
  toggle('フィボナッチ（自動）', S.levels, 'fib');
  toggle('サポート/レジスタンス（自動）', S.levels, 'sr');
  toggle('手動の水平線', S.levels, 'manual');
  toggle('価格アラートの線', S.levels, 'alerts');
  box.appendChild(el('h4', { text: 'マーカー' }));
  toggle('EMA クロス（GC/DC）', S.markers, 'cross');
  toggle('RSI ダイバージェンス', S.markers, 'divergence');
  toggle('ローソク足パターン（直近60本）', S.markers, 'patterns');
  box.appendChild(el('h4', { text: '表示' }));
  toggle('セッション背景色（1時間足以下）', S, 'sessionBg');
  select('週末の足', S, 'weekend', [['dim', '薄く表示'], ['hide', '非表示'], ['show', '通常表示']], () => { $('#setWeekend').value = S.weekend; });
}

export function initSheets(ctx) {
  $('#btnIndicators').addEventListener('click', () => { buildIndicatorSheet(ctx); $('#dlgIndicators').showModal(); });
  $('#btnLevels').addEventListener('click', () => { buildLevelSheet(ctx); $('#dlgLevels').showModal(); });
  for (const id of ['#dlgIndicators', '#dlgLevels', '#dlgSource']) {
    const d = $(id);
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // 背景タップで閉じる
  }
}

// ---------------- 設定画面 ----------------
export function initSettings(ctx) {
  const S = ctx.settings;
  // 13-5 の範囲で検査。範囲外は元の値に戻して範囲を示す（N7）
  const bindNum = (id, key, { after } = {}) => {
    const e = $('#' + id);
    e.value = String(S[key]);
    e.addEventListener('change', () => {
      const v = parseField(key, e.value);
      const old = S[key];
      if (v === null) { e.value = String(old); toast(ruleText(ruleFor(key))); return; }
      S[key] = v;
      if (!crossOk(S)) { S[key] = old; e.value = String(old); toast('最小ロットは最大ロット以下にしてください'); return; }
      e.value = String(v);
      ctx.save(); if (after) after();
      ctx.rerender();
    });
  };
  const bindSel = (id, key, conv = (x) => x, after) => {
    const e = $('#' + id);
    e.value = String(typeof S[key] === 'boolean' ? (S[key] ? 1 : 0) : S[key]);
    e.addEventListener('change', () => { S[key] = conv(e.value); ctx.save(); if (after) after(); });
  };
  // E2: データ元の設定を変えたら gen を上げて全部取り直す（取得中でも捨てない）
  bindSel('setSource', 'sourceMode', (x) => x, () => { ctx.ctrl.setSourceMode(S.sourceMode).then(() => ctx.ctrl.tick()); });
  bindNum('setPriceInt', 'priceIntervalSec');
  const key = $('#setApiKey');
  const showMask = () => { const k = store.getApiKey(); key.value = ''; key.placeholder = k ? `設定済み（…${k.slice(-4)}）` : '未設定'; };
  showMask();
  key.addEventListener('change', () => {
    const v = key.value.trim();
    if (v && !store.setApiKey(v)) { toast('APIキーは空白を含まない 200 文字以内の半角英数記号で入れてください'); key.value = ''; return; }
    if (!v) store.setApiKey('');
    showMask(); toast(store.getApiKey() ? 'APIキーを保存しました（この端末のみ）' : 'APIキーを削除しました');
  });
  $('#btnResetBlocked').addEventListener('click', () => { toast('地域制限の記録をリセットしました。取り直します'); ctx.ctrl.retry({ resetBlocked: true }).then(() => ctx.ctrl.tick()); }); // E3
  $('#btnClearCache').addEventListener('click', () => { ctx.ctrl.clearCache(); toast('キャッシュを消去しました'); }); // E8
  bindSel('setCurrency', 'accountCurrency', (x) => x, () => ctx.rerender());
  bindSel('setUsdJpyAuto', 'usdJpyAuto', (x) => x === '1', () => ctx.updatePriceCard());
  bindNum('setUsdJpy', 'usdJpyManual');
  bindNum('setBalance', 'balance');
  bindNum('setRisk', 'riskPercent', { after: () => { if (S.riskPercent > 5) toast('一般的な目安（1〜2%）を大きく超えています'); } });
  bindNum('setContract', 'contractSize');
  bindNum('setLotStep', 'lotStep');
  bindNum('setMinLot', 'minLot');
  bindNum('setMaxLot', 'maxLot');
  bindNum('setPip', 'pipSize');
  bindNum('setLev', 'leverage', { after: () => { if (S.leverage > 25) toast('国内 FX の個人の上限は 25 倍です'); } });
  bindNum('setAtrMult', 'atrMult');
  const rr = $('#setRR'); rr.value = S.rrList;
  rr.addEventListener('change', () => {
    const v = parseField('rrList', rr.value);
    if (v === null) { rr.value = S.rrList; toast('0.1〜20 の数をカンマ区切りで入れてください（5 個まで）'); return; }
    const typed = rr.value.trim().split(/[,\s、]+/).filter(Boolean);
    if (typed.length !== v.split(',').length) toast(`0.1〜20 の数でない値（または 6 個目以降）を除いて「${v}」にしました`); // R2-4: 黙って直さない
    S.rrList = v; rr.value = v; ctx.save(); ctx.rerender();
  });
  bindSel('setTheme', 'theme', (x) => x, () => { ctx.applyTheme(); ctx.rerender(); });
  bindSel('setWeekend', 'weekend', (x) => x, () => ctx.rerender());
  bindSel('setSessionBg', 'sessionBg', (x) => x === '1', () => ctx.rerender());

  const wf = clear($('#weightsForm'));
  const buildWeights = () => {
    clear(wf);
    for (const k of Object.keys(DEFAULT_WEIGHTS)) {
      const inp = el('input', { inputmode: 'decimal', value: String(S.weights[k]) });
      inp.addEventListener('change', () => {
        const v = parseField('weights.' + k, inp.value);
        if (v === null) { inp.value = String(S.weights[k]); toast('0〜10 の数値にしてください'); return; }
        S.weights[k] = v; ctx.save(); ctx.rerender();
      });
      wf.appendChild(el('label', {}, INDICATOR_NAMES[k], inp));
    }
  };
  buildWeights();
  $('#btnWeightsReset').addEventListener('click', () => { S.weights = { ...DEFAULT_WEIGHTS }; ctx.save(); buildWeights(); ctx.rerender(); });

  $('#btnExport').addEventListener('click', () => {
    const data = store.exportData(S, $('#expJournal').checked);
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `gold-settings-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('エクスポートしました（APIキーは含みません）');
  });
  const undo = $('#btnUndoImport');
  const showUndo = () => { const b = store.backupInfo(); undo.hidden = !b; if (b) undo.textContent = `インポート前に戻す（${new Date(b.at).toLocaleString('ja-JP')} の状態）`; };
  showUndo();
  undo.addEventListener('click', () => {
    if (!confirm('インポートする前の設定・アラート・予定・日記・描画に戻しますか？（戻せるのは 1 回だけです）')) return;
    if (store.restoreBackup()) { alert('インポート前の状態に戻しました。再読み込みします。'); location.reload(); }
    else { toast('戻せる状態がありません'); showUndo(); }
  });
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      if (f.size > 2 * 1024 * 1024) throw new Error('ファイルが大きすぎます（2MB まで）');
      let data;
      try { data = JSON.parse(await f.text()); } catch { throw new Error('JSON として読めません'); }
      store.checkImportFile(data);
      // 取り込む前に件数の差分を見せて確認を取る（R2-2）
      const dlg = $('#dlgImport');
      const draw = () => {
        const mode = dlg.querySelector('input[name="impMode"]:checked').value;
        const ul = clear($('#impPlan'));
        const plan = store.planImport(data, { mode });
        store.describePlan(plan).forEach((t) => ul.appendChild(el('li', { text: t })));
        const b = store.backupInfo();
        if (plan.changes && b) ul.appendChild(el('li', { class: 'warn', text: `直前のバックアップ（${new Date(b.at).toLocaleString('ja-JP')} の状態）は、今の状態で上書きされます` }));
        dlg.querySelector('button[value="ok"]').disabled = !plan.changes; // 何も変わらないときは取り込めない（R3-2）
      };
      dlg.querySelectorAll('input[name="impMode"]').forEach((r) => { r.onchange = draw; });
      dlg.querySelector('input[value="replace"]').checked = true;
      draw();
      dlg.onclose = () => {
        if (dlg.returnValue !== 'ok') { toast('インポートをやめました（何も変更していません）'); return; }
        try {
          const mode = dlg.querySelector('input[name="impMode"]:checked').value;
          const r = store.applyImport(store.planImport(data, { mode }));
          if (!r.changed) { toast('変更される項目が無いため、何もしませんでした'); return; }
          $('#importResult').textContent = `取り込みました: ${r.summary}`;
          alert(`インポートしました。\n${r.summary}\n\n取り込む前の状態は保存してあり、「インポート前に戻す」で 1 回だけ戻せます。\nOK を押すと再読み込みします。`);
          location.reload();
        } catch (err) { toast('インポートできませんでした: ' + err.message); }
      };
      dlg.returnValue = '';
      dlg.showModal();
    } catch (err) { toast('インポートできませんでした: ' + err.message); }
    e.target.value = '';
  });
}
