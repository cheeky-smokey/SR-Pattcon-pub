import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  Pen, PaintBucket, Slash, Square, BoxSelect, Undo2, Redo2,
  MoreHorizontal, Copy, Scissors, ClipboardPaste, Trash2, FlipHorizontal2,
  FlipVertical2, RotateCw, LayoutGrid, Check, X, Plus, Download, Upload,
  ZoomIn, ZoomOut, ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
  Minimize2, Maximize2, FlipHorizontal, AlertTriangle, Eye, Library, BookPlus, Wifi, FolderOpen, Save, FileText, StickyNote
} from "lucide-react";

/* ============================== utils ============================== */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DEFAULT_PALETTE = ["#FFFFFF", "#000000", "#C0392B", "#2E5FA3", "#E8C13F", "#3B8B5A", "#8B5A3B", "#9AA3AF"];
const MAX_S = 240, MAX_R = 1000, MAX_COLORS = 8; // 目数の上限240 = U-BOX/PC10の形式上限(8バイト×4ブロック)、段数の上限1000
/* パターン集に登録できる件数の上限。SRDS.IDX 自体は16384件まで持てるが、アプリ側は3000件で頭打ちにする。
   上限を超える読み込みは、超過ぶんを保存できない旨をダイアログで知らせてから切り捨てる。 */
const MAX_LIB = 3000;
/* 色数の上限8は形式側の制約に合わせたもの。色数フィールドは上位ニブル(1..15)、パス数は編成上8が現実的な上限で、
   既定パレットも8色。上限を8に揃えたことで、編集できるパターンは必ず多色(Nパス)として書き出せる
   (2値へ丸める経路が不要になる)。色番号が0..7に収まるので図案は1目1バイトで保持する。 */
/* 制御4bit（アプリ内部表現）。bit3=ブザー / bit2=a / bit1=b / bit0=c。指示記号は下位3bit(a,b,c)で決まる。
   この内部順はWSプロトコル(kcFrameRow ctrl, bit3=ブザー)・ファーム・描画・編集で統一している。
   ─ 注意 ─ U-BOX/PC10バイナリはニブルのビット順が内部と逆(機器 bit0=ブザー / bit1=下送り(段+) /
   bit2=上送り(段−) / bit3=…、実機確認済み)。そのため読み書きの境界(parseUBox/buildPC10)で nib4rev により
   ビット反転して整合させる。内部側・WS側の順は変更しないこと。 */
const CTRL_SYM = { 4: "<", 2: "＊", 6: "{", 1: ">", 3: "}" };
/* 制御マスの塗り色。指示記号(a/b/c)はそのパスの色、ブザーは色ではなく機器の動作なので常に橙。
   2色パターンは1デザイン段=1パスなので、その色(既定では色番号1の黒)一色になる。 */
const BUZZ_COLOR = "#E8801A";
/* 長押しと判定する時間(ms)。段番号・目番号ガターの挿入/削除メニューと、
   パターンのマスを地色(色0)へ戻す操作で共通に使う。 */
/* SRDS一式(索引 + .DAT)を入れる ZIP のファイル名。書き出しは常にこの名前で、日付は付けない。
   以前は SRDS + 書き出した日付(SRDS20260918.zip)としていたが、日付ごとに別名のZIPが増えて
   どれをカードへ入れたのか分からなくなり混乱のもとになったため固定にした。
   同じ名前のファイルがすでにあるときは、ブラウザが「SRDS (1).zip」などの別名を付ける(上書きはしない)。 */
const SRDS_ZIP_NAME = "SRDS.zip";
const LONGPRESS_MS = 500;
/* ペンツールでマークするときのタップの扱い。入力の種類(PointerEvent.pointerType)で分ける。
   ・タッチペン("pen")とマウス("mouse")は1タップでマークする。ペン先やクリックは意図した操作だけなので、
     ダブルタップにしても誤マークは減らず、逆にペン先のわずかなずれでダブルタップが外れて描けなくなるため。
   ・指("touch")はダブルタップでマークする。タブレットで手やそで、ペンを持ち替える指が触れても
     マークされないようにするため、指の1タップ目では描かない。
   DBLTAP_TYPES に入っている種類だけがダブルタップを要する("pen" を足せばタッチペンもダブルタップになる)。
   導電ゴムのペン先など、ブラウザが指と区別できないペンは "touch" になるので、ダブルタップ側で扱う。
   DBLTAP_MS は1タップ目を押してから2タップ目を押すまでの時間の上限。
   2タップ目は「1タップ目と同じマス」か「1タップ目の押下位置から DBLTAP_SLOP(画面px)以内」なら同じ場所とみなし、
   マークは1タップ目のマスに付ける。マス境界をまたいで数pxずれただけで外れないよう、同じマスは必須にしない。 */
const DBLTAP_TYPES = ["touch"];
const DBLTAP_MS = 500;
const DBLTAP_SLOP = 24;
/* 画面に出す版表記。4形式(.tsx / .jsx / _cdn.html / _offline.html)のどれを開いているのか、
   また古いファイルが残っていないかを画面で見分けるために出す。機能を変えたら必ず更新する。 */
const APP_REV = "rev.47";
/* 版の日付。APP_REV と一緒に更新する(ヘッダーの版表示のツールチップに出す) */
const APP_DATE = "2026-10-18";
const ctrlSymbol = (nib) => CTRL_SYM[(nib || 0) & 7] || "";
/* 4bitニブルのビット順を反転(bit0<->bit3, bit1<->bit2)。U-BOX/PC10バイナリ<->内部表現の変換に使う。 */
const nib4rev = (n) => (((n & 1) << 3) | ((n & 2) << 1) | ((n & 4) >> 1) | ((n & 8) >> 3)) & 0xf;
/* 1バイトのビット並びを反転(bit0<->bit7,…)。PC10は各バイトのビット並びがU-BOXと逆(MSB→LSB)。 */
const bitrev8 = (b) => { b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4); b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2); return (((b & 0xaa) >> 1) | ((b & 0x55) << 1)) & 0xff; };

/* ===== パターン集エントリの表現 =====
   エントリは常に { s, r, grid, palette, colors, control, passControl } で持つ。
   grid は1目=色番号(パレット添字)、palette は色番号→表示色、colors は地色を除く色数 c(1..7)。
   色番号0が地色、1..c が色1..色c。パス数は passCount(c) で、2色(c=1)は1パス(非選針がそのまま地色)、
   3色以上(c>=2)は c+1 パス。パス p(p<=c)は色番号 p の目を、最終パスは地色(色0)の目を選針する。
   地色のみ(0x00)は平編みで柄そのものが要らないので、c の下限は1。
   2値の図案行(. と X)は保持せず、必要なとき gridLines で導出する(SRテキスト書き出し・1パスの選針データ)。 */
/* 行は Uint8Array。TypedArray の map は数値しか返せないため、文字列化はループで行う。 */
const gridLines = (g) => g.map((row) => {
  let out = "";
  for (let i = 0; i < row.length; i++) out += row[i] ? "X" : ".";
  return out;
});
const linesGrid = (lines, s) =>
  lines.map((ln) => Uint8Array.from({ length: s }, (_, i) => (ln[i] === "X" ? 1 : 0)));
/* パレットは常に MAX_COLORS(8) スロット固定。添字がそのまま色番号で、0=地色 / 1..7=色1..色7。
   色数を変えてもスロットは増減しない(色番号が動くと図案の意味が変わるため)。各スロットの
   表示色は任意の24bit色に変更できる。 */
const padPalette = (p) => {
  const out = Array.isArray(p) ? p.slice(0, MAX_COLORS) : [];
  for (let i = out.length; i < MAX_COLORS; i++) out.push(DEFAULT_PALETTE[i]);
  return out.map((h) => (/^#[0-9a-fA-F]{6}$/.test(h || "") ? h : DEFAULT_PALETTE[0]));
};
const entryPalette = () => DEFAULT_PALETTE.slice();
/* #RGB / #RRGGBB / 先頭#なし を #RRGGBB へ正規化する。不正なら null。 */
const normHex = (v) => {
  let t = String(v == null ? "" : v).trim();
  if (t && t[0] !== "#") t = "#" + t;
  if (/^#[0-9a-fA-F]{3}$/.test(t)) t = "#" + t[1] + t[1] + t[2] + t[2] + t[3] + t[3];
  return /^#[0-9a-fA-F]{6}$/.test(t) ? t.toUpperCase() : null;
};
/* 図案で使われている最大の色番号。地色(0)しかなければ0。必要な色数 c の下限になる(パス数は passCount(c))。
   commit のたびに呼ぶので、イテレータを使わず添字で回す。 */
const maxColorNo = (grid) => {
  let m = 0;
  for (const row of grid || []) for (let i = 0; i < row.length; i++) if (row[i] > m) m = row[i];
  return m;
};
/* 2値の図案行からエントリを作る(SRテキスト読込・単色バイナリ読込の共通経路) */
const linesEntry = (s, lines, control) => ({
  s, r: lines.length, grid: linesGrid(lines, s), palette: entryPalette(),
  colors: 1, control: control || new Array(lines.length).fill(0),
});

/* 図案は「行の配列」で、各行は Uint8Array(1目=1バイト=色番号0..7)。
   数値配列より複製が速くメモリも少ないため、undo履歴(最大50件 × 240目 × 1000段)が軽くなる。
   行は添字アクセス・slice・reverse・some・for-of がそのまま使えるが、
   map は数値しか返せない点だけ注意する(文字列化は gridLines のようにループで書く)。 */
const mkGrid = (rows, cols, fill = 0) =>
  Array.from({ length: rows }, () => new Uint8Array(cols).fill(fill));
const cloneGrid = (g) => g.map((r) => r.slice());

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function shade(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const f = amt < 0 ? (v) => v * (1 + amt) : (v) => v + (255 - v) * amt;
  return `rgb(${Math.round(f(r))},${Math.round(f(g))},${Math.round(f(b))})`;
}
/* 背景色 hex の上に置く文字色。黒地なら白、明るい地なら黒。 */
const fgOn = (hex) => (luminance(hex) > 0.55 ? "#1d1d1d" : "#ffffff");
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/* 編み目(メリヤス)風レンダリング: 塗り + 陰V + 光V */
function drawKnitCell(ctx, x, y, w, h, hex) {
  ctx.fillStyle = hex;
  ctx.fillRect(x, y, w + 0.7, h + 0.7);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = shade(hex, -0.4);
  ctx.lineWidth = Math.max(0.7, w * 0.13);
  ctx.beginPath();
  ctx.moveTo(x - w * 0.02, y + h * 0.1);
  ctx.lineTo(x + w * 0.5, y + h * 0.98);
  ctx.lineTo(x + w * 1.02, y + h * 0.1);
  ctx.stroke();
  ctx.strokeStyle = shade(hex, 0.2);
  ctx.lineWidth = Math.max(0.7, w * 0.16);
  ctx.beginPath();
  ctx.moveTo(x + w * 0.12, y - h * 0.04);
  ctx.lineTo(x + w * 0.5, y + h * 0.68);
  ctx.lineTo(x + w * 0.88, y - h * 0.04);
  ctx.stroke();
}

/* ---------- region transforms (cells: number[][] h×w) ---------- */
const extractCells = (grid, sel) => {
  const out = [];
  for (let r = 0; r < sel.h; r++) {
    const row = new Uint8Array(sel.w);
    for (let c = 0; c < sel.w; c++) row[c] = grid[sel.y + r][sel.x + c];
    out.push(row);
  }
  return out;
};
const flipCellsH = (cells) => cells.map((row) => row.slice().reverse());
const flipCellsV = (cells) => cells.slice().reverse();
const rotCellsCW = (cells) => {
  const h = cells.length, w = cells[0].length;
  const out = mkGrid(w, h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) out[c][h - 1 - r] = cells[r][c];
  return out;
};
/* write cells at (x,y); returns true if clipped */
function stampCells(grid, cells, x, y) {
  const R = grid.length, S = grid[0].length;
  let clipped = false;
  for (let r = 0; r < cells.length; r++)
    for (let c = 0; c < cells[0].length; c++) {
      const gy = y + r, gx = x + c;
      if (gy < 0 || gy >= R || gx < 0 || gx >= S) { clipped = true; continue; }
      grid[gy][gx] = cells[r][c];
    }
  return clipped;
}
function fillRegion(grid, sel, color) {
  for (let r = sel.y; r < sel.y + sel.h; r++)
    for (let c = sel.x; c < sel.x + sel.w; c++) grid[r][c] = color;
}
function bresenham(x0, y0, x1, y1, fn) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}
function floodFill(grid, x, y, color) {
  const R = grid.length, S = grid[0].length;
  const target = grid[y][x];
  if (target === color) return;
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cx >= S || cy < 0 || cy >= R || grid[cy][cx] !== target) continue;
    grid[cy][cx] = color;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}
/* SR形式テキストの解析: "SR#####" / "目数,段数" / .とXの行×段数。複数パターン対応。
   段順: ファイルは最下段(段1)が先頭行。U-BOXバイナリ(先頭ブロック=最下段)と同じ向きである。
   内部表現は grid[0]=最上段なので、読み込み時に段順を反転して取り込む(書き出し側 exportSRText も対で反転)。 */
function parseSRText(text) {
  const raw = String(text).split(/\r?\n/);
  const entries = [];
  let i = 0;
  while (i < raw.length) {
    const ln = raw[i].trim();
    if (/^SR\d+$/i.test(ln)) {
      let j = i + 1;
      while (j < raw.length && !raw[j].trim()) j++;
      const m = (raw[j] || "").trim().match(/^(\d+)\s*[,、]\s*(\d+)$/);
      if (m) {
        const s = clamp(parseInt(m[1], 10), 1, MAX_S);
        const r = clamp(parseInt(m[2], 10), 1, MAX_R);
        j++;
        const body = [];
        while (j < raw.length && body.length < r) {
          const t = raw[j].trim();
          if (/^SR\d+$/i.test(t)) break;
          if (t && /^[.Xx]+$/.test(t)) body.push(t);
          j++;
        }
        const lines = [];
        for (let k = 0; k < r; k++) {
          lines.push((body[k] || "").padEnd(s, ".").slice(0, s).replace(/x/g, "X").replace(/[^.X]/g, "."));
        }
        lines.reverse();                 // 先頭行=最下段 → 内部表現(index0=最上段)へ
        entries.push(linesEntry(s, lines));
        i = j;
        continue;
      }
    }
    i++;
  }
  /* ヘッダーなしの素の図案( . と X の行のみ)にも寛容に対応 */
  if (!entries.length) {
    const body = raw.map((l) => l.trim()).filter((l) => l && /^[.Xx]+$/.test(l));
    if (body.length) {
      const s = clamp(Math.max(...body.map((l) => l.length)), 1, MAX_S);
      const r = clamp(body.length, 1, MAX_R);
      /* ヘッダーなしでも段順の規約は同じ(先頭行=最下段)なので反転して取り込む */
      entries.push(linesEntry(s, body.slice(0, r).map((l) => l.padEnd(s, ".").slice(0, s).replace(/x/g, "X")).reverse()));
    }
  }
  return entries;
}

/* ============================== 多色編み(Pパス展開) ==============================
   U-BOX / PC10 とも、多色パターンは1デザイン段を P段(パス1..P)へ展開して格納する。
   色数フィールド(実機確認済み 2026-09): U-BOX = パターンブロック +1 / PC10 = 0x000D。
   いずれも「セパレータ」ではなく、上位ニブルがパス数 P を表す。
     0x10 = 1パス(=2色) / 0x30 = 3パス(=3色) / 0x40 = 4パス(=4色)
   0x00(地色のみ)は平編みで柄そのものが要らないため、パターンとして存在しない。書き出しでも作らない。
   すべり目・スレッド・レース編みは糸としては1色だが柄(選針データ)を持つので、2色編み(1パス)として扱う。
   したがって最小は1パスで、色数フィールドは必ず 0x10 以上になる。
   ─ n色編み = nパス ─ 総色数がそのままパス数になる。最後のパスは地色(色0)の柄で、他のどのパスにも
   選ばれなかった目がそこで選針される。つまり最終パスの柄は自動的に決まり、ユーザーが描くものではない。
   例外は2色で、非選針がそのまま地色になるため地色ぶんのパスが要らず 1パス で足りる。
   したがって 2パス の多色は存在しない(パス数は 1 → 3 → 4 → 5 … と飛ぶ)。
   パス p(p<P)は色番号 p の目だけを選針し、パス P は色番号0(地色)の目を選針する。
   ─ 色と制御4bitは別物 ─ どのパスかは「段位置 mod P」で決まる。パス数Pは色数フィールドから読む。
   制御4bitは色の識別には使わない。PASS_MARK はパスごとに機器が期待する指示記号であって色番号ではなく、
   読み込みの判定にも使わない(判定は排他のみ)。したがって指示記号が未確認の4色以上でも
   展開・畳み込みは成立する。実機確認済みの指示記号は3パスまで(4 / 2 / 6 = 付録B の < / ＊ / {)。
   デザイン段の制御4bit(doc.control)は第1パスの制御そのもので、読み込みでも指示記号のビットを落とさず復元する。 */
const PASS_MARK = [4, 2, 6];            // パスごとの指示記号(実機確認済みは3パスまで。以降は0を書く)
const MAX_COLOR_NO = MAX_COLORS - 1;    // 色番号の上限 = 地色を除く色数の上限(色1..色7)
const MAX_PASS = MAX_COLORS;            // パス数の上限。n色編み = nパスなので最大8パス
const passMark = (p) => PASS_MARK[p - 1] || 0;  // p は1起点のパス番号
/* 多色の色1パスで指示記号 a(<、passMark(1))を「外した」印。デザイン段の制御 control[r] の bit4 に置く。
   ユーザーが編集画面でその段の aビットを外したときだけこの印を立て、aビット(bit2)も下ろす。印は画面の表示だけに効く。
   編み機への転送と U-BOX・PC10 への書き出しは、印に関係なく多色の色1パスに必ず a を付けて出す(機器が期待する値)。
   印の無い段は表示でも a を出すので、この印を知らない版で作った図案・ファイルもそのまま同じ結果になる。
   2色(1パス)では印を見ない(下位4bitがそのまま制御)。 */
const CTRL_A_OFF = 0x10;
/* ─ 多色編みのパス数 ─ (c = 地色を除く色数。総色数は c+1)
   ・2色(c=1) は 1パス。選針が色1、非選針が地色となり、地色ぶんの柄データは要らない。
   ・3色以上(c>=2) は 総色数ぶん、すなわち c+1 パス。最後のパスは地色(色0)の柄で、
     他のどのパスにも選ばれなかった目がそのまま選針になる(＝自動的に決まる)。
   ・したがって 2パス の多色は存在しない。1 → 3 → 4 → … と飛ぶ。
   色数フィールド(上位ニブル)にはこのパス数を書く。0x10=2色 / 0x30=3色 / 0x40=4色(0x00 と 0x20 は現れない)。 */
const passCount = (c) => (c <= 1 ? 1 : c + 1);
/* パス pno(1起点) が担当する色番号。最終パスは地色(色0)。 */
const passColorNo = (pno, P) => (P >= 2 && pno === P ? 0 : pno);
/* 色数の表示名(画面上部の「色数」の選択肢と同じ)。c は地色を除いた色数(doc.colors / entry.colors) */
const colorCountLabel = (c) => (c <= 1 ? "2色(レース)／1パス" : `${c + 1}色／${passCount(c)}パス`);
/* パターン集のパターンと貼り先の色数(色パス数)が違うときの警告文。色数が違うとパスの数と割り当てが変わり、
   貼った部分が意図どおりに編めないので、先に貼り先の色数を合わせてもらう(自動では変えない)。 */
const colorMismatchMsg = (label, ec, dc, when) =>
  `⚠ 色数（色パス数）が一致していません。\n`
  + `コピー元 ${label}: ${colorCountLabel(ec)}\n`
  + `貼り先のパターン: ${colorCountLabel(dc)}\n`
  + `色数が違うと、パスの数と色の割り当てが変わり、貼った部分が意図どおりに編めません。\n`
  + (when === "confirm"
    ? `上の「色数」を ${colorCountLabel(ec)} に合わせてから「確定」してください（配置はそのまま残しています）。`
    : `先に上の「色数」を ${colorCountLabel(ec)} に合わせてから、もう一度${when === "paste" ? "ペースト" : "コピー"}してください。`);
/* Nパス展開後の段数上限。MAX_R(1000)は「デザイン段」の上限なので、バイナリ上の段数は
   その N 倍まで許す。ここを MAX_R のままにすると、例えば400段の3色パターン(=1200段)が
   書き出しで1000段に切り詰められ、読み込みでは段数がNで割り切れず単色として誤読される。
   段数フィールドは2バイトなので、上限(1000×8=8000)は形式側にも収まる。 */
const maxTxRows = (P) => MAX_R * clamp(P || 1, 1, MAX_PASS);
/* デザイン段 r のパス pno に出す制御4bit(n = パス数)。編集画面の表示・バイナリ書き出し(entryPasses)・
   編み機への転送はすべてこの関数の値を使い、計算を1か所に限る。
   ・第1パス(1パスの図案ではその段そのもの)は control[r] だけが正。多色では指示記号 <(passMark(1)=4)を重ねる。
     passControl[r][0] は読み込み時に control[r] と同じ値が入るが参照しない。両方を OR すると、編集で control だけが
     変わったときに古いビットが残り、表示・転送とファイルが食い違う(ブザーを消しても消えなかった不具合)。
     asShown(編集画面の表示)のときだけ、control[r] に CTRL_A_OFF の印がある段は a を重ねない(ユーザーが a を外した段)。
     転送・書き出し(asShown なし)は印に関係なく a を重ねる。
   ・第2パス以降は passControl[r][pno-1] があればそれを、無ければそのパスの指示記号を出す。 */
function passControlOf(control, passControl, r, pno, n, asShown = false) {
  const raw = (control || [])[r] || 0, own = raw & 0xf;
  if (n < 2) return own;
  if (pno === 1) return ((own & ~passMark(1)) | (asShown && (raw & CTRL_A_OFF) ? 0 : passMark(1))) & 0xf;
  const a = (passControl || [])[r];
  return ((a && a[pno - 1] != null) ? a[pno - 1] : passMark(pno)) & 0xf;
}
/* 色数バイトを作る(上位ニブル=パス数P、下位ニブルは0)。最小は 0x10(2色=1パス)で、3色は 0x30。
   地色のみの 0x00 は平編み＝柄が不要なので書き出さない。 */
const colorNibble = (P) => ((clamp(P || 1, 1, 0xf) & 0xf) << 4);

/* エントリをバイナリ書き出し用の段列へ展開する。戻り値は { passes, lines, control }。
   多色(色数 c>=2 → P=c+1 パス)は 1デザイン段 → Pパス段。段1(最下段)から パス1..P の順に並べ、
   最後に内部表現(index0=最上段)へ戻す。1パス(2色)は段の並びがそのまま図案。
   制御4bitは passControlOf で求める(編集画面の表示・編み機への転送と同じ値)。 */
function entryPasses(e) {
  /* 色数の下限は1(=2色)。地色のみ(0)は平編みでパターンが要らないため、この経路には来ない。
     すべり目・スレッド・レースのような1色の柄も2色編みとして1パスで書き出す。 */
  const c = clamp(e.colors || 1, 1, MAX_COLOR_NO);
  const P = passCount(c);
  /* 1パス(=2色)は1デザイン段=1段。地色(0)以外が選針になる。 */
  if (P < 2) return { passes: 1, lines: gridLines(e.grid), control: e.grid.map((_, g) => passControlOf(e.control, e.passControl, g, 1, 1)) };
  const lines = [], control = [];
  for (let g = e.grid.length - 1; g >= 0; g--) {          // 内部 index0=最上段 → 最下段から走査
    for (let p = 1; p <= P; p++) {
      const want = passColorNo(p, P);                     // 最終パスは地色(色0)の柄
      let line = "";
      for (let col = 0; col < e.s; col++) line += (e.grid[g][col] === want ? "X" : ".");
      const nib = passControlOf(e.control, e.passControl, g, p, P);   // 転送と同じ計算(多色の色1パスは必ず a あり)
      lines.push(line); control.push(nib & 0xf);
    }
  }
  lines.reverse(); control.reverse();                     // 内部表現(index0=最上段)へ
  return { passes: P, lines, control };
}
/* 段列が N パス展開かを判定する。次を満たすこと:
     ・段数が N で割り切れる
     ・各デザイン段のN段で、どの目も高々1パスしか選針されない(排他)
   どのパスにも選ばれない目は地色(色番号0)なので、完全被覆は条件にしない。
   制御4bitも判定に使わない(色とは別物)。どのパスかは段位置で決まり、Nは色数フィールドから与える。 */
function isNPassExpanded(lines, s, n) {
  const r = lines.length;
  if (!(n >= 2) || n > MAX_PASS || r < n || r % n) return false;
  const upL = lines.slice().reverse();                    // index0 = 段1(最下段)
  for (let g = 0; g * n < r; g++) {
    for (let col = 0; col < s; col++) {
      let hit = 0;
      for (let p = 0; p < n; p++) if (upL[g * n + p][col] === "X") hit++;
      if (hit > 1) return false;                          // 複数パスで重複 → Nパス展開ではない
    }
  }
  return true;
}
/* パス数(=色数)を確定する。色数フィールドの値を正とし、選針データがNパス展開として
   成り立つことだけを確認する。成り立たなければ 1(単色=展開なし)として扱う。
   値を推測しないので、市松模様のように偶然「排他かつ被覆」になる単色パターンを誤検出しない。 */
function detectPassCount(lines, s, headerN) {
  return isNPassExpanded(lines, s, headerN) ? headerN : 1;
}
/* デザイン段の制御4bitは「色番号1のパス(=第1パス)の制御4bit」とする。指示記号のビットも落とさず
   そのまま採る(機器が第1パスへ出す指示そのものなので、編集画面にも同じものを見せる)。 */
function designControls(control, n) {
  const up = control.slice().reverse(), out = [];
  for (let g = 0; g * n < up.length; g++) out.push((up[g * n] || 0) & 0xf);
  return out.reverse();
}
/* 各パスの制御4bitをデザイン段ごとの配列にして残す(passControl[段][パス-1])。
   第2パス以降にも指示記号やブザーが入っていることがあり、表示と書き戻しで失わないために保持する。 */
function passControls(control, n) {
  const up = control.slice().reverse(), out = [];
  for (let g = 0; g * n < up.length; g++) {
    const a = [];
    for (let p = 0; p < n; p++) a.push((up[g * n + p] || 0) & 0xf);
    out.push(a);
  }
  return out.reverse();
}
/* Pパス展開の段列を、1デザイン段=1行の色番号グリッドへ畳み込む。
   パスp(1起点、p<P)で選針された目 → 色番号 p。最終パスPは地色(色0)の柄なので読み飛ばす
   (そこで選針されている目は、どの色のパスにも入らないので自然に0になる)。 */
function collapsePasses(lines, s, P) {
  const upL = lines.slice().reverse();                    // index0 = 段1(最下段)
  const out = [];
  for (let g = 0; g * P < upL.length; g++) {
    const row = new Uint8Array(s);
    for (let col = 0; col < s; col++) {
      for (let p = 1; p < P; p++) if (upL[g * P + p - 1][col] === "X") { row[col] = p; break; }
    }
    out.push(row);
  }
  return out.reverse();                                   // 内部表現(index0=最上段)へ
}
/* バイナリから読んだ段列をパターン集エントリへ。単色・多色とも grid / palette / colors で返す。 */
function binToEntry(o) {
  const s = o.s, lines = o.lines, control = o.control, truncated = !!o.truncated;
  const headerN = o.headerColors | 0;
  const P = detectPassCount(lines, s, headerN);
  /* 1パス以下は段の並びがそのまま図案。柄を持つ以上どれも2色編み(colors=1)として扱う。
     色数フィールドが2パス以上なのに展開として成り立たなかったときは、元のパス数を passFallback に残して
     読み込み側で知らせる(黙って2色へ落とさない)。 */
  if (P < 2) return { ...linesEntry(s, lines, control), colors: 1, truncated, ...(headerN >= 2 ? { passFallback: headerN } : {}) };
  /* Pパスのうち最後は地色ぶん。図案が持つ色は地色を除いて P−1 色(=総色数 P)。 */
  const grid = collapsePasses(lines, s, P);
  return {
    s, r: grid.length, grid, colors: clamp(P - 1, 1, MAX_COLOR_NO), palette: entryPalette(),
    control: designControls(control, P),
    passControl: passControls(control, P),
    truncated,
  };
}

/* U-BOXメモリカードのバイナリを生成する(parseUBox の対)。
   ヘッダー7バイト + パターンブロック(4バイト + 段数×rowBytes)を収録数ぶん連結する。
   図案ビットは連続パッキング(目i = byte(i>>3) の bit(i&7)、LSB→MSB)、制御4bitは各段の
   行末バイト上位ニブルへ nib4rev で反転して格納する。いずれも parseUBox と同一の規約。
   段順はバイナリ先頭ブロックが最下段(段1)なので、内部表現(index0=最上段)から反転して書く。 */
const UBOX_MAX = 256;   // U-BOXカード1枚の収録上限。0x06 が「収録パターン数 − 1」の1バイトのため
function buildUBox(entries) {
  const list = entries.slice(0, UBOX_MAX);   // 超えるぶんは呼び出し側(exportUBox)で確認してから渡す
  if (!list.length) return new Uint8Array(0);
  const blocks = list.map((e) => {
    /* 多色エントリはここでNパス段へ展開する。段数は展開後の段数になる。 */
    const pl = entryPasses(e);
    const s = clamp(e.s, 1, MAX_S), r = clamp(pl.lines.length, 1, maxTxRows(pl.passes));
    const rowBytes = clamp(Math.ceil(s / 60), 1, 4) * 8;
    /* 段数ぶんに揃えてから反転する。長さの異なる配列を先に反転すると段と制御がずれる */
    const lines = Array.from({ length: r }, (_, y) => (pl.lines[y] || "").padEnd(s, ".")).reverse();
    const ctrl = Array.from({ length: r }, (_, y) => ((pl.control || [])[y] || 0) & 0xf).reverse();
    const out = new Uint8Array(4 + r * rowBytes);
    out[0] = s - 1;            // 編み目数 − 1
    out[1] = colorNibble(pl.passes); // 上位ニブル=パス数。2色=0x10 / 3色=0x30 / 4色=0x40
    out[2] = r & 0xff;         // 段数(リトルエンディアン)
    out[3] = (r >> 8) & 0xff;
    for (let y = 0; y < r; y++) {
      const base = 4 + y * rowBytes, line = lines[y];
      for (let col = 0; col < s; col++) {
        if (line[col] === "X") out[base + (col >> 3)] |= 1 << (col & 7);
      }
      out[base + rowBytes - 1] |= (nib4rev(ctrl[y]) & 0xf) << 4;
    }
    return out;
  });
  const total = 7 + blocks.reduce((a, b) => a + b.length, 0);
  const buf = new Uint8Array(total);
  /* 識別子 "SR" + 0x1F。0x03 変更不可 / 0x04 予備 / 0x05 コピー不可 は実カードの通常値に倣う */
  buf[0] = 0x53; buf[1] = 0x52; buf[2] = 0x1f;
  buf[3] = 0x00; buf[4] = 0x00; buf[5] = 0xff;
  buf[6] = list.length - 1;  // 収録パターン数 − 1
  let p = 7;
  for (const b of blocks) { buf.set(b, p); p += b.length; }
  return buf;
}

/* U-BOXメモリカードのバイナリを解析してエントリ(binToEntry)の配列に変換する。
   仕様(要約):
   [ヘッダー7バイト] byte0..2 = "SR"+0x1f(通常 0x53,0x52,0x1f) / byte3 変更不可フラグ /
     byte4 予備 / byte5 コピー不可(0xff) / byte6 = 収録パターン数-1
   [パターンブロック(byte7以降)] を byte6+1 個ぶん連結:
     +0: 編み目数-1 / +1: 多色編みの色数(上位ニブル=パス数。0x10=2色1パス/0x30=3色3パス/0x40=4色4パス) /
     +2..+3: 段数(2byteリトルエンディアン) /
     +4以降: 図案データ。1行 = 8バイト×(ceil(目数/60)ブロック)、最大4ブロック(=240目)。
   ビットは段のバイト列を通した連番で、目i = byte(i>>3) の bit(i&7)(各バイトLSB→MSB)。
   1=マークする(X)、0=マークしない(.)。8バイト=64bitに対し1ブロック60目なので、
   60目を超える段では2ブロック目の先頭が1ブロック目のbyte7上位ニブルから続く
   (ブロック境界でビット位置を戻さない)。制御4bitは段の最終バイトの上位ニブル。
   段の並びは先頭ブロック=最下段(段1)、目の並びは bit0=左端(目1)。SRテキストと同じ向き。 */
function parseUBox(buffer) {
  const b = new Uint8Array(buffer);
  /* ヘッダー先頭の "SR"(0x53,0x52) を形式判定に使う */
  if (b.length < 7 || b[0] !== 0x53 || b[1] !== 0x52) return { magic: false, entries: [], truncated: false };
  const count = b[6] + 1; // 収録パターン数 = byte6 + 1
  const entries = [];
  let truncated = false;
  let p = 7; // 最初のパターンブロックの先頭
  for (let n = 0; n < count; n++) {
    if (p + 4 > b.length) { truncated = true; break; } // ブロックヘッダーが足りない
    const stitches = b[p] + 1;                    // 編み目数 = byte + 1
    const headerColors = (b[p + 1] >> 4) & 0xf;    // +1 = 多色編みの色数(上位ニブル=パス数)
    const rows = b[p + 2] | (b[p + 3] << 8);       // 段数(リトルエンディアン)
    p += 4;
    const blocksPerRow = clamp(Math.ceil(stitches / 60), 1, 4); // 1行あたりのブロック数(最大4)
    const rowBytes = blocksPerRow * 8;
    const s = clamp(stitches, 1, MAX_S);
    /* 段数は展開後の値。色数Nのぶんだけ上限を引き上げる(デザイン段としては MAX_R に収まる) */
    const rMax = clamp(rows, 1, maxTxRows(headerColors));
    const lines = [];
    const control = [];
    for (let r = 0; r < rMax; r++) {
      const rowBase = p + r * rowBytes;
      if (rowBase + rowBytes > b.length) { truncated = true; break; } // データが途中で終了
      let line = "";
      for (let col = 0; col < s; col++) {
        /* 目のビットは行のバイト列を通した連番で並ぶ(連続パッキング)。目i = byte(i>>3) の bit(i&7)、LSB→MSB。
           ブロック境界(60目)でビット位置を戻さない。8バイト=64bitのうち60目を超えるぶんはbyte7上位ニブル→次バイトへ連続。
           制御4bitは行末バイト(rowBytes-1)の上位ニブル。
           ※実機確認済み(2026-09): 60目超のU-BOX SRバイナリが正しく表示。ブロック単位インデックスは4目ずれを生むため使用しないこと。 */
        const on = (b[rowBase + (col >> 3)] >> (col & 7)) & 1;
        line += on ? "X" : ".";
      }
      lines.push(line);
      /* 制御4bit = その段の最終バイトの上位ニブル(=最終ブロックのbyte7上位ニブル)。
         U-BOXはニブルのビット順が内部表現と逆(機器 bit0=ブザー…)なので nib4rev で反転して取り込む。 */
      const lastByte7 = b[rowBase + rowBytes - 1] || 0;
      control.push(nib4rev((lastByte7 >> 4) & 0xf));
    }
    /* パターン表示は最下段=1段目=バイナリ先頭ブロック。内部 grid は上端=index0 の規約なので、
       先頭ブロックが最下段(=末尾index)に来るよう段順を反転して格納する(実機の段順に一致)。 */
    lines.reverse(); control.reverse();
    p += rows * rowBytes; // 次のパターンへ(クランプ前の実データ長で進める)
    /* 多色(Nパス展開)なら色番号グリッドへ畳み込む。単色はそのまま */
    if (lines.length) entries.push(binToEntry({ s, lines, control, headerColors }));
  }
  return { magic: true, entries, truncated };
}

/* 複数ファイルを1つのZIPにまとめる(無圧縮=storedのみ)。
   ブラウザは連続したダウンロードを抑止することがあるため、まとめて1回で受け取れる経路を用意する。
   ファイル名はASCIIのみを想定(SRDS.IDX / SR00000.DAT)。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildZip(files) {
  const enc = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
  const locals = [], centrals = [];
  let offset = 0;
  for (const [bin, name] of files) {
    const nm = enc(name), crc = crc32(bin), size = bin.length;
    const lh = new Uint8Array(30 + nm.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);   // ローカルヘッダ署名
    lv.setUint16(4, 20, true);           // 展開に必要なバージョン
    lv.setUint16(8, 0, true);            // 圧縮方式 0 = stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);        // 圧縮後サイズ(=元サイズ)
    lv.setUint32(22, size, true);
    lv.setUint16(26, nm.length, true);
    lh.set(nm, 30);
    const cd = new Uint8Array(46 + nm.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);   // 中央ディレクトリ署名
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, nm.length, true);
    cv.setUint32(42, offset, true);      // 対応するローカルヘッダの位置
    cd.set(nm, 46);
    locals.push(lh, bin); centrals.push(cd);
    offset += lh.length + size;
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // 終端レコード署名
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

/* ===== パターン集ファイル(全データの保存と読み込み) =====
   パターン集の全エントリを、失うものなく1つの JSON ファイルへ保存し、そのまま復元する。
   U-BOX / PC10 / SRテキストへの書き出しは、形式の制約で表示色・件数・色(2値化)などを失うため、
   パターン集のバックアップと復元にはこの形式を使う。
   {
     "format": "SilverReedPatternLibrary", "version": 1, "savedAt": ISO時刻, "count": 件数,
     "memo": メモ(任意。無いか空なら省く。改行は \n),
     "entries": [ { "name": "SR00000", "s": 目数, "r": 段数, "colors": 地色を除く色数, "palette": [8色],
                    "grid": [r本の文字列。grid[0]=最上段、1文字=1目の色番号 "0".."7"],
                    "control": [r個。第1パス(デザイン段)の制御4bit。多色で a を外した段は bit4(CTRL_A_OFF)も立つ(0..31)],
                    "passControl": [r個。null または パスごとの制御4bit](全段 null なら省略),
                    "crc32": 8桁16進 } ]
   }
   1エントリを1行に書き、差分や目視での確認をしやすくする。crc32 は正規形(libNormalize)の値を決まった順に
   並べたバイト列から求め、読み込みで再計算して照合する(破損・途中切れ・手編集の検出)。
   name は目で見るためのもので、読み込みでは位置から振り直す(srName)。 */
const LIB_FORMAT = "SilverReedPatternLibrary";
/* ===== ファイル形式の版(version) =====
   パターン集ファイル(LIB_FORMAT)と現在のパターンの JSON(PAT_FORMAT)に共通の整数の版。判定にはこの version だけを使い、
   app(保存したアプリの APP_REV)は記録用で判定には使わない。
     v1 … これまでの形式。制御4bit(control)は 0〜15。
     v2 … control に多色の色1パスの a を外した印 CTRL_A_OFF(bit4)を含む(0〜31)。
   ・保存は、中身に必要な最も低い版で書く(fileVersionFor)。印を使っていなければ v1 のままなので、古いアプリでも読める。
   ・版を上げるのは、古いアプリで読むと中身が壊れる・意味が変わる変更のときだけ。古いアプリが無視できる項目を足すだけ
     (パターン集のメモなど)なら上げない。
   ・読み込み(fileVersion): 版が無ければ v1、このアプリより新しい版は読まずに理由を出す、古い版は FILE_UPGRADE で
     1段ずつ今の形へ変換してから読む。
   ・rev.23〜27 は印を含んでも version 1 と書いていたため、v1 でも control は 0〜31 を受け付ける(v1→v2 の変換は無し)。 */
const FILE_VERSION = 2;                 // このアプリが読み書きできる最新の版
const LIB_VERSION = FILE_VERSION;
const PAT_FORMAT = "SilverReedPattern"; // 現在のパターンの JSON(1パターン)
/* 古い版 v を v+1 の形へ変換する関数(v1→v2 は中身が同じなので何もしない) */
const FILE_UPGRADE = { 1: (d) => d };
/* 中身に必要な最も低い版。control に CTRL_A_OFF の印があれば v2、無ければ v1 */
const fileVersionFor = (controls) => {
  for (const c of controls) for (let i = 0; i < (c || []).length; i++) if (c[i] & CTRL_A_OFF) return 2;
  return 1;
};
/* ファイルの版を読む。版が無ければ v1。整数でなければ・このアプリより新しければ、理由つきの例外を投げる */
function fileVersion(d) {
  if (d.version == null) return 1;
  const v = Number(d.version);
  if (!Number.isInteger(v) || v < 1) throw new Error(`ファイルの版の値が正しくありません（version: ${String(d.version).slice(0, 20)}）`);
  if (v > FILE_VERSION) {
    const by = typeof d.app === "string" && d.app ? `・${d.app.slice(0, 20)} で保存` : "";
    throw new Error(`新しい版のアプリで保存されたファイルです（ファイル v${v}${by}／このアプリ ${APP_REV} は v${FILE_VERSION} まで）。\nアプリを更新してから読み込んでください`);
  }
  return v;
}
/* 古い版のファイルを今の版の形へ1段ずつ変換する */
function upgradeFile(d, v) {
  let x = d;
  for (let k = v; k < FILE_VERSION; k++) x = FILE_UPGRADE[k](x);
  return x;
}
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/* パターン集のメモ。保存名を尋ねるダイアログで入力・編集し、ファイルの先頭(entries の前)へ "memo" として書く。
   入力枠は全角25字 × 10行ぶんの大きさで、それより長く書いたときは枠の中でスクロールする。
   ファイルが際限なく膨らまないよう全体で LIB_MEMO_MAX 文字までとし、超えた分は入力の時点で切る。
   version は上げない。memo を知らない版のアプリはこのキーを読み飛ばすだけで、パターンは今までどおり読める。 */
const LIB_MEMO_COLS = 25;
const LIB_MEMO_ROWS = 10;
const LIB_MEMO_MAX = 2000;
/* メモを保存用にそろえる。改行を \n にし、各行の行末の空白と末尾の空行を落として上限で切る。
   保存と読み込みで同じ関数を通すので、書き出した文字列を読み戻すと必ず同じになる。 */
const libNormMemo = (raw) => String(raw == null ? "" : raw)
  .replace(/\r\n?/g, "\n").replace(/[ \t\u3000]+$/gm, "").replace(/\n+$/, "").slice(0, LIB_MEMO_MAX);

/* エントリを保存用の正規形へ。長さを s / r にそろえ、値を範囲に収め、表示色を大文字にする。
   アプリ内で作られたエントリでは値は変わらない。 */
function libNormalize(e) {
  const s = clamp(e.s | 0, 1, MAX_S), r = clamp(e.r | 0, 1, MAX_R);
  const G = e.grid || [], CT = e.control || [], PC = e.passControl || [];
  const grid = new Array(r), control = new Array(r), passControl = new Array(r);
  let m = 0;                                     // 使っている最大の色番号(色数の下限)
  for (let y = 0; y < r; y++) {                  // 3000件でも速いよう、コールバックを使わずに回す
    const src = G[y] || [], row = new Uint8Array(s);
    for (let x = 0; x < s; x++) {
      const v = src[x] | 0;
      if (v > 0 && v <= MAX_COLOR_NO) { row[x] = v; if (v > m) m = v; }   // 範囲外は地色(0)
    }
    grid[y] = row;
    control[y] = (CT[y] | 0) & 0x1f;               // 下位4bit + a を外した印(CTRL_A_OFF)
    const a = PC[y];
    if (Array.isArray(a)) {
      const k = Math.min(a.length, MAX_PASS), o = new Array(k);
      for (let i = 0; i < k; i++) o[i] = (a[i] | 0) & 0xf;
      passControl[y] = o;
    } else passControl[y] = null;
  }
  return {
    s, r, grid, control, passControl,
    palette: padPalette(e.palette).map((h) => h.toUpperCase()),
    colors: clamp(Math.max(e.colors | 0, m, 1), 1, MAX_COLOR_NO),
  };
}

/* 正規形のチェックサム。s・r(各2バイトLE)、colors、パレット8色のRGB、図案(r×s)、control(r)、
   passControl(段ごとに 長さ1バイト(null は 0xFF)+値) の順に並べた CRC32 を8桁16進で返す。 */
function libChecksum(n) {
  let len = 5 + MAX_COLORS * 3 + n.r * n.s + n.r;
  for (const a of n.passControl) len += 1 + (a ? a.length : 0);
  const b = new Uint8Array(len);
  let o = 0;
  b[o++] = n.s & 0xff; b[o++] = n.s >> 8; b[o++] = n.r & 0xff; b[o++] = n.r >> 8; b[o++] = n.colors;
  for (const h of n.palette) { const c = hexToRgb(h); b[o++] = c.r; b[o++] = c.g; b[o++] = c.b; }
  for (const row of n.grid) { b.set(row, o); o += n.s; }
  for (const v of n.control) b[o++] = v;
  for (const a of n.passControl) {
    if (!a) { b[o++] = 0xff; continue; }
    b[o++] = a.length;
    for (const v of a) b[o++] = v;
  }
  return crc32(b).toString(16).padStart(8, "0");
}

/* パターン集をファイルの文字列にする。memo は空なら書かない（キーごと省く） */
function libraryToJSON(entries, savedAt, memo) {
  const buf = new Uint8Array(MAX_S);
  const rowText = (row) => {                     // 1段 → "0120…"(1文字=1目の色番号)
    for (let x = 0; x < row.length; x++) buf[x] = 48 + row[x];
    return String.fromCharCode.apply(null, buf.subarray(0, row.length));
  };
  const ns = entries.map(libNormalize);
  const lines = ns.map((n, i) => {
    const rec = {
      name: "SR" + String(i).padStart(5, "0"), s: n.s, r: n.r, colors: n.colors, palette: n.palette,
      grid: n.grid.map(rowText),
      control: n.control,
    };
    if (n.passControl.some((a) => a)) rec.passControl = n.passControl;
    rec.crc32 = libChecksum(n);
    return JSON.stringify(rec);
  });
  const h = { format: LIB_FORMAT, version: fileVersionFor(ns.map((n) => n.control)), app: APP_REV, savedAt, count: entries.length };
  const m = libNormMemo(memo);
  if (m) h.memo = m;
  const head = JSON.stringify(h);
  return head.slice(0, -1) + ',"entries":[\n' + lines.join(",\n") + "\n]}\n";
}

/* 現在のパターンの JSON を読む。パターン集ファイルなら { library: true } を返す(呼び出し側でパターン集の読み込みへ回す)。
   種類が違う・版が新しい・図案が無いなど読めないときは、理由つきの例外を投げる。
   format の無いファイル(rev.27 まで)は v1 のパターン JSON として読む。 */
function parsePatternJSON(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error("JSON として読めません（ファイルが途中で切れているか、別の形式です）"); }
  if (!d || typeof d !== "object") throw new Error("パターンのファイルではありません");
  if (d.format === LIB_FORMAT) return { library: true };
  if (d.format != null && d.format !== PAT_FORMAT)
    throw new Error(`別の種類のファイルです（format: ${String(d.format).slice(0, 40)}）`);
  const ver = fileVersion(d);
  d = upgradeFile(d, ver);
  if (!Array.isArray(d.grid) || !Array.isArray(d.palette)) throw new Error("図案(grid)または配色(palette)がありません");
  const ns = clamp(d.stitches | 0, 1, MAX_S), nr = clamp(d.rows | 0, 1, MAX_R);
  const g = mkGrid(nr, ns, 0);
  for (let r = 0; r < nr; r++) for (let c = 0; c < ns; c++) {
    const v = d.grid[r]?.[c] | 0;
    g[r][c] = v >= 0 && v < MAX_COLORS ? v : 0;   // 色番号はそのまま保つ
  }
  /* control は a を外した印(bit4)も含めて 0〜31。passControl は 4bit */
  const ctrl = Array.from({ length: nr }, (_, r) => ((Array.isArray(d.control) && (d.control[r] | 0)) || 0) & 0x1f);
  const pctrl = Array.from({ length: nr }, (_, r) => {
    const a = Array.isArray(d.passControl) ? d.passControl[r] : null;
    return Array.isArray(a) ? a.map((v) => (v | 0) & 0xf) : null;
  });
  return {
    doc: { stitches: ns, rows: nr, palette: padPalette(d.palette), grid: g, control: ctrl, passControl: pctrl,
           colors: clamp(Math.max(+d.colors || 1, maxColorNo(g)), 1, MAX_COLOR_NO), gaugeRatio: clamp(+d.gaugeRatio || 0.75, 0.4, 1.2) },
    version: ver, app: typeof d.app === "string" ? d.app.slice(0, 20) : "",
  };
}

/* パターン集ファイルを読む。ファイルそのものが違えば理由つきの例外を投げる。
   各エントリは正規形へそろえて取り込み、読めずに飛ばした件・値を補正した件・チェックサムが合わない件・
   チェックサムの無い件を、ファイル内の位置(0起点)で返す。 */
function parseLibraryJSON(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error("JSON として読めません（ファイルが途中で切れているか、別の形式です）"); }
  if (d && typeof d === "object" && (d.format === PAT_FORMAT || (d.format !== LIB_FORMAT && Array.isArray(d.grid))))
    throw new Error("1パターンぶんの JSON です。メニューの「JSON読み込み(現在のパターン)」で開いてください");
  if (!d || typeof d !== "object" || d.format !== LIB_FORMAT || !Array.isArray(d.entries))
    throw new Error("パターン集ファイルではありません（「パターン集を保存」で作ったファイルを選んでください）");
  const ver = fileVersion(d);                   // 新しい版は理由つきで読まない
  d = upgradeFile(d, ver);
  const res = { entries: [], skipped: [], fixed: [], crcNg: [], noCrc: [], count: d.count, savedAt: d.savedAt,
                version: ver, app: typeof d.app === "string" ? d.app.slice(0, 20) : "",
                memo: typeof d.memo === "string" ? libNormMemo(d.memo) : "" };
  const nib = (v) => Number.isInteger(v) && v >= 0 && v <= 15;
  const ctl = (v) => Number.isInteger(v) && v >= 0 && v <= 31;   // control は a を外した印(bit4)も持つ
  d.entries.forEach((x, i) => {
    const s = x && x.s, r = x && x.r;
    if (!x || typeof x !== "object" || !Number.isInteger(s) || !Number.isInteger(r)
      || s < 1 || s > MAX_S || r < 1 || r > MAX_R || !Array.isArray(x.grid)) { res.skipped.push(i); return; }
    /* 検査と正規形づくりを1回の走査で行う(3000件でも速いよう、コールバックを使わずに回す) */
    let bad = x.grid.length !== r, m = 0;
    const CT = Array.isArray(x.control) ? x.control : null, PC = Array.isArray(x.passControl) ? x.passControl : null;
    if (!CT || CT.length !== r) bad = true;
    if (x.passControl != null && (!PC || PC.length !== r)) bad = true;
    const grid = new Array(r), control = new Array(r), passControl = new Array(r);
    let anyPc = false;
    for (let y = 0; y < r; y++) {
      const src = x.grid[y], row = new Uint8Array(s);
      if (typeof src !== "string" || src.length !== s) bad = true;
      const t = typeof src === "string" ? src : "";
      for (let k = 0; k < s; k++) {
        const v = t.charCodeAt(k) - 48;                       // 範囲外や欠け(NaN)は地色にして補正扱い
        if (v >= 0 && v <= MAX_COLOR_NO) { row[k] = v; if (v > m) m = v; } else bad = true;
      }
      grid[y] = row;
      const cv = CT ? CT[y] : 0;
      if (!ctl(cv)) bad = true;
      control[y] = (cv | 0) & 0x1f;
      const a = PC ? PC[y] : null;
      if (Array.isArray(a)) {
        if (a.length > MAX_PASS) bad = true;
        const k = Math.min(a.length, MAX_PASS), o = new Array(k);
        for (let j = 0; j < k; j++) { if (!nib(a[j])) bad = true; o[j] = (a[j] | 0) & 0xf; }
        passControl[y] = o; anyPc = true;
      } else {
        if (a != null) bad = true;
        passControl[y] = null;
      }
    }
    if (!(Array.isArray(x.palette) && x.palette.length === MAX_COLORS && x.palette.every((h) => HEX6.test(h || "")))) bad = true;
    if (!(Number.isInteger(x.colors) && x.colors >= 1 && x.colors <= MAX_COLOR_NO && x.colors >= m)) bad = true;
    const n = {
      s, r, grid, control, passControl,
      palette: padPalette(x.palette).map((h) => h.toUpperCase()),
      colors: clamp(Math.max(x.colors | 0, m, 1), 1, MAX_COLOR_NO),
    };
    const e = { s, r, grid, palette: n.palette, colors: n.colors, control };
    if (anyPc) e.passControl = passControl;
    res.entries.push(e);
    if (bad) res.fixed.push(i);
    if (typeof x.crc32 !== "string") res.noCrc.push(i);
    else if (x.crc32.toLowerCase() !== libChecksum(n)) res.crcNg.push(i);
  });
  return res;
}

/* エントリ a を正規形にしたものが、読み込んだエントリ b(正規形)と全値一致するか。保存直後の読み戻し検査に使う。
   チェックサムに頼らず全値を比べる。3000件でも速いよう、a の正規形は作らずにその場で比べる。 */
function libSame(a, b) {
  const s = clamp(a.s | 0, 1, MAX_S), r = clamp(a.r | 0, 1, MAX_R);
  if (s !== b.s || r !== b.r) return false;
  const pal = padPalette(a.palette);
  for (let i = 0; i < MAX_COLORS; i++) if (pal[i].toUpperCase() !== b.palette[i]) return false;
  let m = 0;
  for (let y = 0; y < r; y++) {
    const src = (a.grid || [])[y] || [], q = b.grid[y];
    for (let x = 0; x < s; x++) {
      let v = src[x] | 0;
      if (!(v >= 0 && v <= MAX_COLOR_NO)) v = 0;
      if (v !== q[x]) return false;
      if (v > m) m = v;
    }
    if ((((a.control || [])[y] | 0) & 0x1f) !== b.control[y]) return false;
    const u = (a.passControl || [])[y], w = b.passControl ? b.passControl[y] : null;
    if (Array.isArray(u) !== !!w) return false;
    if (w) {
      const uu = u.slice(0, MAX_PASS);
      if (uu.length !== w.length) return false;
      for (let k = 0; k < w.length; k++) if (((uu[k] | 0) & 0xf) !== w[k]) return false;
    }
  }
  return clamp(Math.max(a.colors | 0, m, 1), 1, MAX_COLOR_NO) === b.colors;
}

/* SRDSシステムの索引ファイル SRDS.IDX を生成する。
   SRDS は本体を SRxxxxx.DAT として個別に持ち、その収録数と各ファイルの存在状態を
   この索引で保持する。構造:
   0x00-0x07 "SRDS.IDX"(8byte) / 0x08 0x00000010 / 0x0C 0x00000000(意味未確定) /
   0x10 データ数N / 0x14 データ数N(同値) / 0x18-0x817 存在ビットマップ(64bit単位)。
   ヘッダの4バイト値(0x08 / 0x0C / 0x10 / 0x14)はビッグエンディアン。
   存在ビットマップの64bitワードだけはリトルエンディアン。同一ファイル内で混在するので注意。
   ファイル長は 2072 バイト固定。ヘッダ24バイト + ビットマップ2048バイト(256ワード)で、
   収録数によらず同じ長さになる。ビットマップは先頭からN個ぶんのビットを立て、
   N が64の倍数でなければ最終ワードは下位 N%64 ビットのみ、それ以降は0で埋める。
   ビットマップ容量は 2048×8 = 16384 件。 */
const SRDS_MAGIC = "SRDS.IDX";
const SRDS_FIELD08 = 0x00000010;
/* 0x0C は実機由来ファイルでも 0x00000000 であり、この値で PC10 側が読み込めることを確認済み。
   フィールドが何を表すのかは未確定だが、書き出す値としては確定している。 */
const SRDS_FIELD0C = 0x00000000;
const SRDS_SIZE = 2072;                       // ファイル長(固定)
const SRDS_BITMAP_OFF = 0x18;                 // ビットマップ開始位置
const SRDS_BITMAP_WORDS = (SRDS_SIZE - SRDS_BITMAP_OFF) / 8;  // 256ワード = 16384件
function buildSRDSIdx(n) {
  const count = Math.max(0, Math.min(SRDS_BITMAP_WORDS * 64, n | 0));
  const words = Math.ceil(count / 64);
  const buf = new Uint8Array(SRDS_SIZE);      // 未使用領域は0のまま
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < SRDS_MAGIC.length; i++) buf[i] = SRDS_MAGIC.charCodeAt(i);
  dv.setUint32(0x08, SRDS_FIELD08, false);   // false = ビッグエンディアン
  dv.setUint32(0x0c, SRDS_FIELD0C, false);
  dv.setUint32(0x10, count, false);
  dv.setUint32(0x14, count, false);
  for (let i = 0; i < words; i++) {
    const rest = count - i * 64;                 // このワードが受け持つ残り件数(1以上)
    const lo = rest >= 32 ? 0xffffffff : (2 ** rest - 1) >>> 0;
    const hi = rest >= 64 ? 0xffffffff : rest > 32 ? (2 ** (rest - 32) - 1) >>> 0 : 0;
    /* ビットマップのみリトルエンディアン。下位32bitが先で、先頭ビット(通し番号0)は
       そのワードの先頭バイトの最下位ビットに位置する。ヘッダ(BE)とは逆向き。 */
    dv.setUint32(SRDS_BITMAP_OFF + i * 8, lo, true);
    dv.setUint32(SRDS_BITMAP_OFF + i * 8 + 4, hi, true);
  }
  return buf;
}

/* 1パターンをパタコン(PC10)の .DAT バイナリ(1ファイル=1パターン)に変換する。
   構造:
   0x0000-0x0001 "SR"(0x53,0x52) / 0x0002-0x0006 パターンNo(ASCII5桁) /
   0x0007-0x000A ".DAT"(拡張子4byte) / 0x000B セパレータ0x00 /
   0x000C 編み目数-1 / 0x000D 多色編みの色数(上位ニブル=パス数。0x10=2色1パス/0x30=3色3パス/0x40=4色4パス) /
   0x000E-0x000F 段数(2byteリトルエンディアン) /
   0x0010以降 パターンブロック(1行=8バイト×ceil(目数/60)ブロック、最大4ブロック=240目)。
   目の配置(連続パッキング)と行末の制御4bitは U-BOX と同じ規則で組み、最後に各バイトを bitrev8 で反転する。
   したがってファイル上は各バイト MSB→LSB で、制御4bitは段の最終バイトの下位ニブル(内部値そのまま)。
   ※0x000Cは「編み目数-1」で格納する。受領仕様書の記載は「編み目数」だが、U-BOX形式の同じ量と同様に
     -1 であることを実機で確認済み(2026-09)。素の目数を書くと1目ずれるので変更しないこと。 */
function buildPC10(entry, patternNo) {
  /* 多色エントリはNパス段へ展開する。段数フィールドは展開後の段数(4.3.5) */
  const pl = entryPasses(entry);
  const s = clamp(entry.s, 1, MAX_S), r = clamp(pl.lines.length, 1, maxTxRows(pl.passes));
  const blocksPerRow = clamp(Math.ceil(s / 60), 1, 4);
  const header = new Uint8Array(16);
  header[0] = 0x53; header[1] = 0x52;                 // "SR"
  const no = String(patternNo).padStart(5, "0").slice(-5);
  for (let k = 0; k < 5; k++) header[2 + k] = no.charCodeAt(k); // パターンNo(5桁)
  const ext = ".DAT";
  for (let k = 0; k < 4; k++) header[7 + k] = ext.charCodeAt(k); // 拡張子
  header[0x0b] = 0x00;                                 // セパレータ
  header[0x0c] = clamp(s - 1, 0, 255);                 // 編み目数-1(実機確認済み。U-BOXと同一)
  header[0x0d] = colorNibble(pl.passes);               // 上位ニブル=パス数(2色=0x10 / 3色=0x30)
  header[0x0e] = r & 0xff;                             // 段数 下位
  header[0x0f] = (r >> 8) & 0xff;                      // 段数 上位(リトルエンディアン)
  const body = [];
  /* パターンブロックは段1(最下段)を先頭に書き出す。展開後の段列 pl.lines は index0=最上段なので、末尾(最下段=段1)から順に書く。 */
  for (let blk = 0; blk < r; blk++) {
    const srcRow = r - 1 - blk;                        // 先頭ブロック=最下段(段1)
    /* まずU-BOXと同じ内容で1段ぶんを組む(目は連番配置=連続パッキング LSB→MSB、制御は行末バイト上位ニブル)。
       PC10は各バイトのビット並びがU-BOXと逆(MSB→LSB)なので、最後に各バイトをbitrev8で反転する。
       目の連番配置・行末制御はU-BOXと同一で、相違はバイト内ビット順のみ。 */
    const rowBytes = blocksPerRow * 8;
    const rowBuf = new Uint8Array(rowBytes);
    const line = pl.lines[srcRow] || "";
    for (let col = 0; col < s; col++) {
      if (line[col] === "X") rowBuf[col >> 3] |= (1 << (col & 7)); // 目iを連番で配置(byte i>>3 の bit i&7)
    }
    /* 制御4bitは最終ブロックのbyte7上位ニブルのみ有効(=rowBytes-1)。途中ブロックの制御ニブルは未書込のため0000。
       PC10バイナリのニブル順はU-BOXと同一(内部表現と逆)なのでnib4revで反転して格納する。 */
    const nib = (pl.control && pl.control[srcRow]) || 0;
    rowBuf[rowBytes - 1] |= (nib4rev(nib) & 0xf) << 4;
    for (let k = 0; k < rowBytes; k++) rowBuf[k] = bitrev8(rowBuf[k]); // PC10: 各バイトMSB→LSBへ反転
    for (let k = 0; k < rowBytes; k++) body.push(rowBuf[k]);
  }
  const out = new Uint8Array(16 + body.length);
  out.set(header, 0);
  out.set(body, 16);
  return out;
}
/* PC10(パタコン)の .DAT バイナリを解析する(buildPC10 の対)。
   ヘッダー16バイトのあとに 1段 = 8バイト×ceil(目数/60)ブロック が段数ぶん並ぶ。先頭ブロック=段1(最下段)。
   各バイトはMSB→LSB(U-BOXと逆)なので bitrev8 で反転してから、U-BOXと同じ連続パッキングで読む。
   制御4bitは反転後バイトの上位ニブルを nib4rev で内部表現へ(反転前の生バイト下位ニブルと同値)。
   多色は 0x000D の色数(上位ニブル=パス数)をもとに畳み込む(binToEntry)。 */
function parsePC10(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length < 16 || b[0] !== 0x53 || b[1] !== 0x52) return { magic: false, entry: null };
  const ext = String.fromCharCode(b[7], b[8], b[9], b[10]).toUpperCase();
  if (ext !== ".DAT") return { magic: false, entry: null };
  const s = clamp(b[0x0c] + 1, 1, MAX_S);              // 0x000C = 編み目数-1(U-BOXと同一。実機確認済み)
  const rows = b[0x0e] | (b[0x0f] << 8);                // 0x000E-0F = 段数(リトルエンディアン)
  const headerColors = (b[0x0d] >> 4) & 0xf;           // 0x000D = 多色編みの色数(上位ニブル=パス数)
  const rowBytes = clamp(Math.ceil(s / 60), 1, 4) * 8;
  /* 段数は展開後の値。色数Nのぶんだけ上限を引き上げる(デザイン段としては MAX_R に収まる) */
  const rMax = clamp(rows, 1, maxTxRows(headerColors));
  const lines = [], control = [];
  let truncated = false;
  for (let i = 0; i < rMax; i++) {
    const base = 16 + i * rowBytes;
    if (base + rowBytes > b.length) { truncated = true; break; } // データが途中で終了
    const row = new Uint8Array(rowBytes);
    for (let k = 0; k < rowBytes; k++) row[k] = bitrev8(b[base + k]); // PC10 → U-BOXと同じビット向きへ
    let line = "";
    for (let col = 0; col < s; col++) line += ((row[col >> 3] >> (col & 7)) & 1) ? "X" : ".";
    lines.push(line);
    control.push(nib4rev((row[rowBytes - 1] >> 4) & 0xf));
  }
  lines.reverse(); control.reverse();                  // 先頭ブロック=最下段 → 内部表現(index0=最上段)
  if (!lines.length) return { magic: true, entry: null, truncated };
  return { magic: true, entry: binToEntry({ s, lines, control, headerColors, truncated }), truncated };
}
/* アンカーは document へ挿入してからクリックする。未挿入のままだと click() が無視される
   ブラウザがあるため。クリック後は即座に取り除く。 */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener"; a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* パターン集の縮小表示。図案を max×max の枠に収まる大きさへ最近傍で縮め、ImageData を1回だけ置く。
   ・枠より大きい図案は実数倍で縮小する(以前は1目=1px未満にできず、枠からはみ出して一部しか見えなかった)
   ・枠より小さい図案は整数倍に拡大して目をくっきり見せる
   ・1目ずつ fillRect すると 3000件×数千目で一覧の描画に十数秒かかるため、画素を直接書く
   ・画面外のサムネイルは見えてから描く(IntersectionObserver が無い環境ではすぐ描く) */
const THUMB_NONE = { r: 0x26, g: 0x28, b: 0x2e };
function SRThumb({ entry, max = 72 }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  const s = Math.max(1, entry.s), r = Math.max(1, entry.r);
  const k = Math.min(max / s, max / r);
  const scale = k >= 1 ? Math.floor(k) : k;              // 拡大は整数倍、縮小は実数倍
  const w = Math.max(1, Math.round(s * scale)), h = Math.max(1, Math.round(r * scale));
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !seen) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const pal = padPalette(entry.palette).map(hexToRgb);
    const img = ctx.createImageData(W, H), d = img.data;
    const xs = new Int32Array(W);
    for (let x = 0; x < W; x++) xs[x] = Math.min(s - 1, Math.floor((x * s) / W));
    for (let y = 0, o = 0; y < H; y++) {
      const row = entry.grid[Math.min(r - 1, Math.floor((y * r) / H))] || [];
      for (let x = 0; x < W; x++, o += 4) {
        const c = pal[row[xs[x]]] || THUMB_NONE;
        d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [entry, seen, w, h, s, r]);
  return <canvas ref={ref} width={1} height={1} style={{ display: "block", width: w, height: h, borderRadius: 3, boxShadow: "0 1px 4px rgba(0,0,0,.45)", imageRendering: "pixelated" }} />;
}

/* ============================== 編み機コントロール（WS転送） ============================== */
/* 変換純関数（アイコン・パターン共用）。目ビットは送出時に左端(目1)=bit0 で直列化する(kcPackRow)。*/
const bmInvert  = (b) => b.map((r) => r.map((c) => (c ? 0 : 1)));
const bmHflip   = (b) => b.map((r) => [...r].reverse());
const bmVscale  = (b) => b.flatMap((r) => [r.slice(), r.slice()]);
const bmHscale  = (b) => b.map((r) => r.flatMap((c) => [c, c]));
const bmMirror  = (b) => b.map((r) => [...r, ...[...r].reverse()]);          // 目数 2n
const bmChevron = (b) => b.map((r) => [...r, ...[...r].reverse().slice(1)]); // 目数 2n-1
/* 内容変換の唯一の経路。順序は 反転→左右反転→折返し(0=原/1=ミラー/2=シェブロン)で固定し、
   機器側実装と一致させる。縦横2倍は内容を変えず keyFlags で機器へ伝える(表示・送出とも等倍)。
   反転は2値(N<=1)のときだけ意味を持つ。多色では色とパスの対応が壊れるため行わない
   (UI 側でも passN>1 のときは反転ボタンを受け付けない)。
   ※以前あった2値専用の kcDerive() は、この関数に一本化したため削除した(未使用だった)。 */
/* 色番号グリッドの0/1反転(2値のときだけ使う) */
const cgInvert = (g) => g.map((r) => { const o = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r[i] ? 0 : 1; return o; });
const kcDeriveColor = (base, invert, hflip, fold, n) => {
  let p = base;
  if (invert && n <= 1) p = cgInvert(p);
  if (hflip) p = bmHflip(p);
  if (fold === 1) p = bmMirror(p);
  else if (fold === 2) p = bmChevron(p);
  return p;
};
/* 編み機へ送る段列をつくる。多色は1デザイン段 = Nパス段で、パスkは色番号kの目だけを選針する。
   送出はパス1→パスN の順でなければならない。送り方向 dir=0(段+)は添字の大きい側から送るため、
   その場合だけ段内のパスを逆順に積んで、走査順が必ずパス1から始まるようにする。
   最終パスは地色(色0)の柄を選針する。
   戻り値: rows=選針ビットマップ、pass=各段のパス番号、color=そのパスが担当する色番号、
   design=各段が属するデザイン段の内部添字。 */
function expandPassRows(cg, n, dir) {
  const rows = [], pass = [], color = [], design = [];
  const N = Math.max(1, n);
  for (let y = 0; y < cg.length; y++) {
    for (let k = 0; k < N; k++) {
      const pno = dir === 0 ? N - k : k + 1;
      const want = passColorNo(pno, N);                   // 最終パスは地色(色0)の柄
      const srcRow = cg[y], row = new Uint8Array(srcRow.length);
      for (let x = 0; x < srcRow.length; x++) row[x] = (n < 2 ? (srcRow[x] ? 1 : 0) : (srcRow[x] === want ? 1 : 0));
      rows.push(row); pass.push(n < 2 ? 1 : pno); color.push(n < 2 ? 1 : want); design.push(y);
    }
  }
  return { rows, pass, color, design };
}
const KC_FOLD = ["オリジナル", "ミラー", "シェブロン"];
/* 編成の先頭段の内部添字。dir=0(段+)なら段1(=len-1)、dir=1(段−)なら段R(=0)。
   表示段N と内部添字 i は N = rows - i(仕様書2.2)。編み機コントロールも表示モードと同じ向きで描く(段1=最下段)。 */
const headIdx = (dir, len) => (dir === 0 ? Math.max(0, len - 1) : 0);
/* 送り方向の初期値。0 = 段+ / 1 = 段−。開始段は headIdx() が決める(段+なら段1から)。
   画面は段1が最下段なので、段+ は編み進むほどカーソルが上へ移動する＝上向きの送りとなる。 */
const KC_DIR_INIT = 0;
/* 無応答の扱い。
   READY は機器が即座に返すはずのものなので、来なければ機器がいないと判断して転送を止める。
   ACK は「1段編み終えた」合図で、キャリッジを手で動かす間ずっと待つのが正常なため、時間で止めてはいけない。
   代わりに待ち時間を画面に出し、長くなれば警告色にして、止めるかどうかは操作者に委ねる。 */
const KC_READY_TIMEOUT_MS = 3000;   // MODE_ENTER → READY の待ち上限。超えたら転送を止めてエラー表示
const KC_WAIT_SHOW_MS = 5000;       // 応答待ちの経過表示を出し始める
const KC_WAIT_ALERT_MS = 30000;     // 経過表示を警告色に切り替える
/* keyFlags: 反転1 / 左右2 / ミラー4 / シェブロン8 / 縦2倍16 / 横2倍32 */
const kcKf = (iv, hf, fd, vx, hx) => (iv ? 1 : 0) | (hf ? 2 : 0) | (fd === 1 ? 4 : 0) | (fd === 2 ? 8 : 0) | (vx === 2 ? 16 : 0) | (hx === 2 ? 32 : 0);

/* WSフレーム（1バイト型タグ多重化 / bit7=1 はサーバ→クライアント） */
const KC_TAG = { MODE_ENTER: 0x01, ROW_DATA: 0x02, STOP: 0x03, CALIB: 0x04, BYE: 0x05, READY: 0x81, ACK: 0x82, STOPPED: 0x83, STATUS: 0x84, DISCONNECT: 0x85, NAK: 0x8f };
/* プロトコル v2 (多色編み拡張)。v1 のフレーム末尾へ追記するだけなので、v1 のファームは追記部分を読み飛ばして動く。
   MODE_ENTER: v1(6byte) + [パス数N(1,3..8)] + [パレット 8色×RGB = 24byte] = 31byte
   ROW_DATA  : v1(8 + ceil(目数/8)) + [パス番号(1..N)] + [色番号(0..7)]
   ファームはパス番号・色番号を段位置(添字 mod N と dir)から求めた値と照合し、食い違えば NAK(code 3) を返す。 */
/* プロトコル v3 (キャリッジ制御, 6.3.5〜6.3.6 / 6.9)。KnitCtrl_M5 が実機のキャリッジの信号を読んで選針するときの追加。
   READY [1] の版が 3 以上の機器は、空通し(往復)を済ませるまで編み込みを始められない(ROW_DATA に NAK code 4)。
   CALIB  : [04][開始側 0=右端 / 1=左端] … 空通しを始める。機器は LCD と音声で置き場所と動かす向きを案内する。
   STATUS : [84] + 39byte … 機器が状態の変わるたびに送る(kcParseStatus)。キャリッジの位置・次に動かす向き・
            空通しの結果(選針区間・先行)・不一致の理由・空通しで検知したカーソルを、アプリと機器の両方で同じに
            把握するために使う。古い機器は 24 / 28byte で送るので、足りない項目は読まない。
   版 2 の機器(表示専用)は CALIB を使わず STATUS も送らないので、空通しを求めずに従来どおり送る。
   BYE        : [05] … 利用者の「切断」・コントロールを閉じる・ページを閉じるときに、閉じる直前に送る(rev.36)。
                M5キャリコンは BYE のあとの切断だけを「SRパタコン接続待ち」にする。BYE のない切断(ネットワーク等)では
                画面を変えない(rev.37)。古い機器は知らないタグとして読み捨てる。
   DISCONNECT : [85] … M5キャリコンからの切断要求(本体の A+C 長押し、rev.37)。アプリは BYE を返して閉じ、
                編み機コントロールを閉じてパターン表示に戻る。
   rev.36 のネットワーク障害時の自動再接続(10 回)・応答途絶の監視・READY [2] は rev.37 で取りやめた。 */
const KC_PROTO_VER = 3;
const KC_CAL_PROTO = 3;   // READY の版がこれ以上の機器は空通しが要る
/* NAK [3] のエラーコード(仕様書 6.3.4)。機器が返した理由をそのまま画面と通信ログに出す。 */
const KC_NAK_MSG = {
  1: "ROW_DATA 破損・範囲外(目数・段添字・長さ)",
  2: "MODE_ENTER 不正(パス数が2または9以上／段数がパス数の倍数でない／段数が上限超え)",
  3: "パス番号・色番号が段位置と不一致(パスの解釈が食い違っています)",
  4: "空通しが済んでいません(先に「空通し」でポイントカムとカーソルの位置を確かめてください)",
};
/* ---- キャリッジ制御 (v3) ---- */
/* STATUS [1] 段階 / [2] キャリッジの位置 / [3] 今の動き / [4] 次に動かす向き */
const KC_PHASE = ["未較正", "空通し待ち", "空通し 往路", "空通し 復路", "空通し完了", "編み込み中"];
const KC_SIDE = ["右端", "左端", "移動中"];
/* STATUS [6] 空通しの不一致の理由(ビット) / [7] 編み込み中の警告(ビット)。機器の calErrText と同じ文 */
const KC_CAL_ERR = [[1, "カーソルが見つかりません"], [2, "カーソルが2つ以上あります"], [4, "ポイントカム1・2がありません"],
  [8, "往復でポイントカムの数が違います"], [16, "ポイントカムが多すぎます"], [32, "往復で位置が一致しません"],
  [64, "キャリッジの向きが違います"], [128, "信号が多すぎます"]];
const KC_WARN = [[1, "データが届く前に区間へ入りました(その段は平編み)"], [2, "段の途中で折り返しました(同じ段をもう一度編みます)"],
  [4, "針の位置がずれています(空通しをやり直してください)"]];
const kcBitsText = (v, tbl) => tbl.filter(([b]) => v & b).map(([, t]) => t).join("／");
const kcI16 = (d, o) => { const v = d[o] | (d[o + 1] << 8); return v >= 0x8000 ? v - 0x10000 : v; };
/* STATUS(24〜40byte)を読む。区間(wins)と pos はカーソル(パターンの目1)を0とした針位置で、右が+。
   pos はキャリッジ(選針位置)のいまの針位置で、機器が位置を合わせられているときだけ入る(rev.32 の機器から。それ以前は null)。
   curs は空通しで検知したカーソル(rev.34 の機器から。40byte 未満なら null)。[0] 往路 / [1] 復路 それぞれ
   { list: その向きで最初に検知したカーソルを 0 とし、2 つめ以降は進行方向へ何目あとか(4 つまで), over: 5 つ以上あった }。
   スタート・反転時のパルスは含まない。往復とも 1 つずつ([0])なら正常 */
function kcParseStatus(d) {
  if (!d || d[0] !== KC_TAG.STATUS || d.length < 24) return null;
  const nwin = Math.min(2, d[10]);
  return {
    phase: d[1], side: d[2], move: d[3], next: d[4], start: d[5], err: d[6], warn: d[7], count: d[8] | (d[9] << 8),
    nwin, pc3: !!(d[11] & 1), calibrated: !!(d[11] & 2), off: kcI16(d, 12),
    wins: [[kcI16(d, 14), kcI16(d, 16)], [kcI16(d, 18), kcI16(d, 20)]].slice(0, nwin), trav: d[22] | (d[23] << 8),
    pos: d.length >= 27 && (d[26] & 1) ? kcI16(d, 24) : null,
    curs: d.length >= 40 ? [0, 1].map((p) => {
      const n = Math.min(4, (d[27] >> (p * 3)) & 7);
      return { list: Array.from({ length: n }, (_, i) => (i ? kcI16(d, 28 + p * 6 + (i - 1) * 2) : 0)), over: !!(d[27] & (p ? 0x80 : 0x40)) };
    }) : null,
  };
}
/* 模擬サーバ用に STATUS を組む(kcParseStatus の逆) */
function kcFrameStatus(s) {
  const b = new Uint8Array(40), w16 = (o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
  b[0] = KC_TAG.STATUS; b[1] = s.phase | 0; b[2] = s.side | 0; b[3] = s.move | 0; b[4] = s.next | 0; b[5] = s.start | 0;
  b[6] = s.err | 0; b[7] = s.warn | 0; w16(8, s.count | 0); b[10] = (s.wins || []).length;
  b[11] = (s.pc3 ? 1 : 0) | (s.calibrated ? 2 : 0); w16(12, s.off | 0);
  (s.wins || []).slice(0, 2).forEach(([lo, hi], i) => { w16(14 + i * 4, lo); w16(16 + i * 4, hi); });
  w16(22, s.trav | 0);
  if (s.pos != null) { w16(24, s.pos | 0); b[26] = 1; }
  (s.curs || []).slice(0, 2).forEach((c, p) => {     // 空通しで検知したカーソル(往路・復路)
    const L = (c && c.list) || [], n = Math.min(4, L.length);
    b[27] |= (n << (p * 3)) | (c && c.over ? (p ? 0x80 : 0x40) : 0);
    for (let i = 1; i < n; i++) w16(28 + p * 6 + (i - 1) * 2, (L[i] | 0) - (L[0] | 0));
  });
  return b;
}
/* 空通しで検知したカーソルの表示。最初を 0、2 つめ以降は進行方向へ何目あとか("0, +1目")。なければ「なし」 */
const kcCurText = (c) => (c && c.list.length ? c.list.map((v, i) => (i === 0 ? "0" : `${v > 0 ? "+" : ""}${v}`)).join(", ") + (c.list.length > 1 ? "目" : "") + (c.over ? " …" : "") : "なし");
const kcCalOk = (st) => !!(st && st.calibrated && (st.phase === 4 || st.phase === 5));
const kcDirText = (n) => (n === 1 ? "左へ" : n === 2 ? "右へ" : "");
const kcArrow = (n) => (n === 1 ? "◀" : n === 2 ? "▶" : "・");
/* 機器の LCD と同じ案内文(音声ガイドの内容)。st = STATUS、side = 選んでいる開始側("R"/"L") */
function kcGuide(st, side) {
  const end = side === "L" ? "左端" : "右端";
  if (!st) return `開始側を選んで「空通し」を押してください`;
  const lr = kcDirText(st.next);
  switch (st.phase) {
    case 0: return `開始側を選んで「空通し」を押してください（機器の A ボタンでも始められます）`;
    case 1: return `キャリッジを${end}に置いて、${lr}空通ししてください`;
    case 2: return `${st.next === 1 ? "左" : "右"}端まで動かしてください`;
    case 3: return `${lr}戻してください`;
    case 4: return `空通しが済みました。スタートでパターン送信を始められます`;
    case 5: return `キャリッジを${lr}動かしてください`;
    default: return "";
  }
}
const kcNakText = (code) => KC_NAK_MSG[code] || `不明なエラーコード ${code}`;
const kcPalBytes = (pal) => padPalette(pal).flatMap((h) => { const { r, g, b } = hexToRgb(h); return [r, g, b]; });
const kcU16 = (v) => [v & 0xff, (v >> 8) & 0xff]; // little-endian（段番号/段数は2byte=最大65535, 1000段対応）
function kcPackRow(row) { // bit0=左端の目(目1)、各バイトLSB→MSB、1=マーク。PC10/U-BOXと同一方向(左端=先頭)
  const n = row.length, b = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) if (row[i]) b[i >> 3] |= 1 << (i & 7); // 目i(左端=0) → bit i
  return b;
}
const kcFrameModeEnter = (w, rows, kf, passes = 1, pal = DEFAULT_PALETTE) => Uint8Array.from([KC_TAG.MODE_ENTER, ...kcU16(w), ...kcU16(rows), kf & 0xff, clamp(passes | 0, 1, MAX_PASS), ...kcPalBytes(pal)]);
const kcFrameRow = (idx, row, kf, ctrl, dir, pno = 1, colorNo = 1) => Uint8Array.from([KC_TAG.ROW_DATA, ...kcU16(idx), kf & 0xff, ctrl & 0x0f, dir & 1, ...kcU16(row.length), ...kcPackRow(row), pno & 0xff, colorNo & 0xff]);
const kcFrameStop = () => Uint8Array.from([KC_TAG.STOP]);
const kcFrameCalib = (side) => Uint8Array.from([KC_TAG.CALIB, side === "L" ? 1 : 0]);
const kcFrameBye = () => Uint8Array.from([KC_TAG.BYE]);
const kcHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(" ");
/* WebSocket の受信データを Uint8Array にする。binaryType = "arraybuffer" を指定しているので通常は
   ArrayBuffer だが、TypedArray で渡す実装や別のレルム(iframe など)から来た ArrayBuffer でも
   取りこぼさないよう、instanceof ではなく byteLength の有無で判定する。
   文字列や Blob(binaryType の既定)は対象外なので null を返す。 */
const asBytes = (data) => {
  if (!data || typeof data === "string") return null;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return typeof data.byteLength === "number" ? new Uint8Array(data) : null;
};
function kcBits(bytes) { // 送出バイト列から表示順(左→右)で復元
  if (bytes[0] !== KC_TAG.ROW_DATA) return null;
  const w = bytes[6] | (bytes[7] << 8), d = bytes.subarray(8);
  let s = ""; for (let p = 0; p < w; p++) { s += ((d[p >> 3] >> (p & 7)) & 1) ? "X" : "."; } return s; // bit0=左端(目1)
}

/* 添付のピクセルアヒルをサンプル図案に、各変換を適用したプレビューアイコン */
const DUCK = [
  ".....XXXXX............", "....XXXXXXX...........", "...XXXXXXXXX..........", ".XXXXXXXXXXX..........",
  ".XXXXXXXXXXX..........", ".XXXXXXXXXXX..........", "....XXXXXXXX..........", ".....XXXXXX...........",
  ".....XXXXX...........X", "....XXXXXX..........XX", "...XXXXXXX........XXXX", "..XXXXXXXX........XXXX",
  "..XXXXXXXX.....XXXXXXX", ".XXXXXXXXXX..XXXXXXXXX", ".XXXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXXX.",
  "XXXXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXXXX", ".XXXXXXXXXXXXXXXXXXXX.",
  ".XXXXXXXXXXXXXXXXXXX..", "..XXXXXXXXXXXXXXXXXX..", "...XXXXXXXXXXXXXXXX...", "....XXXXXXXXXXXXX.....",
].map((s) => [...s].map((ch) => (ch === "X" ? 1 : 0)));
const DUCK_MIRROR = [
  "XXXXXXXXXXXXXXXXXXXXXXXX..XXXXXXXXXXXXXXXXXXXXXXXX",
  "X......................X..X......................X",
  "X......................X..X......................X",
  "X...........XXXX.......X..X.......XXXX...........X",
  "X..........XXXXXX......X..X......XXXXXX..........X",
  "X..........XXXXXXX.....X..X.....XXXXXXX..........X",
  "X..........XXXXXXXX....X..X...XXXXXXXXX..........X",
  "X..........XXXXXXXX....X..X....XXXXXXXX..........X",
  "X..........XXXXX.......X..X.......XXXXX..........X",
  "X...X.......XXXX.......X..X.......XXXX.......X...X",
  "X...XX.......XXXX......X..X......XXXX.......XX...X",
  "X...XXX......XXXXX.....X..X.....XXXXX......XXX...X",
  "X...XXXXX...XXXXXXX....X..X....XXXXXX....XXXXX...X",
  "X...XXXXXX.XXXXXXXX....X..X...XXXXXXXX..XXXXXX...X",
  "X...XXXXXXXXXXXXXXXX...X..X...XXXXXXXXXXXXXXXX...X",
  "X...XXXXXXXXXXXXXXXX...X..X...XXXXXXXXXXXXXXXX...X",
  "X...XXXXXXXXXXXXXXXX...X..X...XXXXXXXXXXXXXXXX...X",
  "X...XXXXXXXXXXXXXXXX...X..X...XXXXXXXXXXXXXXXX...X",
  "X....XXXXXXXXXXXXXX....X..X...XXXXXXXXXXXXXXX....X",
  "X.....XXXXXXXXXXXX.....X..X....XXXXXXXXXXXXX.....X",
  "X......XXXXXXXXXXX.....X..X.....XXXXXXXXXXX......X",
  "X........XXXXXXXX......X..X......XXXXXXXX........X",
  "X......................X..X......................X",
  "XXXXXXXXXXXXXXXXXXXXXXXX..XXXXXXXXXXXXXXXXXXXXXXXX",
].map((s) => [...s].map((ch) => (ch === "X" ? 1 : 0)));
const DUCK_CHEVRON = [
  "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "X.....................XX.....................X",
  "X.....................XX.....................X",
  "X..........XXXX.......XX.......XXX...........X",
  "X.........XXXXXX......XX......XXXXX..........X",
  "X.........XXXXXXX.....XX....XXXXXXXX.........X",
  "X.........XXXXXXXX....XX....XXXXXXXX.........X",
  "X.........XXXXX.......XX......XXXXXX.........X",
  "X..........XXXX.......XX.......XXXX..........X",
  "X...X.......XXX.......XX.......XXX.......X...X",
  "X...XXX.....XXXX......XX......XXXX......XX...X",
  "X...XXXXX..XXXXXX.....XX.....XXXXX...XXXXX...X",
  "X...XXXXXX.XXXXXXX....XX....XXXXXXX.XXXXXX...X",
  "X...XXXXXXXXXXXXXX....XX....XXXXXXXXXXXXX....X",
  "X...XXXXXXXXXXXXXX....XX...XXXXXXXXXXXXXXX...X",
  "X...XXXXXXXXXXXXXX....XX...XXXXXXXXXXXXXXX...X",
  "X...XXXXXXXXXXXXXX....XX....XXXXXXXXXXXXX....X",
  "X....XXXXXXXXXXXX.....XX.....XXXXXXXXXXX.....X",
  "X.....XXXXXXXXXX......XX......XXXXXXXXX......X",
  "X.......XXXXXXX.......XX.......XXXXXXX.......X",
  "X.....................XX.....................X",
  "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
].map((s) => [...s].map((ch) => (ch === "X" ? 1 : 0)));
const KC_ICON = { orig: DUCK, invert: bmInvert(DUCK), hflip: bmHflip(DUCK), vscale: bmVscale(DUCK), hscale: bmHscale(DUCK), mirror: DUCK_MIRROR, chevron: DUCK_CHEVRON };
function Icon({ bmp, px = 28, frame = true }) {
  const h = bmp.length, w = bmp[0].length, rects = [];
  for (let y = 0; y < h; y++) { let x = 0; while (x < w) { if (bmp[y][x]) { let e = x; while (e < w && bmp[y][e]) e++; rects.push(<rect key={y * w + x} x={x} y={y} width={e - x} height={1} />); x = e; } else x++; } }
  return (
    <svg width={px} height={px} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" shapeRendering="crispEdges" className="fill-current">
      {frame && <rect x="0" y="0" width={w} height={h} fill="none" stroke="currentColor" strokeWidth="0.7" opacity="0.3" />}
      {rects}
    </svg>
  );
}

/* 編み機コントロール本体：doc の色番号グリッドに変換を非破壊で適用し、パス段へ展開(expandPassRows)してWS転送する。
   スタート/ストップ トグル → ハンドシェイク(MODE_ENTER→READY) → ROW_DATA送信→ACKで次段を自動送出。
   編段はループ(最終段→先頭)。転送済み(紫)は直近1段のみ。縦2倍/横2倍は表示等倍でkeyFlags通知のみ。 */
/* サブネット取得：手動URLのArduino/M5Stackへ 0x10(HELLO) を送り、応答 0x90(INFO)=[接続元IP 4byte][ホスト名 UTF-8]
   を受けて、接続元IP(=このPCのLAN IP)からサブネットを算出する。ホスト名で各コントローラーを区別する。
   探索はポーリングせず、「検索」ボタン押下時のみ /24 を1回走査して応答機(=M5Stack編み機コントローラー等)を一覧化する。 */
/* 検索サブネットの候補。家庭用ルーター／M5Stack のAPでよく使われるプライベートIPの /24 を並べ、
   最後の「直接入力」でどの /24 でも打ち込めるようにする。値はいずれも先頭3オクテット。 */
const SUBNET_PRESETS = ["192.168.0", "192.168.1", "10.0.0", "172.16.0"];
const SUBNET_MANUAL = "__manual__";
/* 走査の並列数と待ち時間。1周目は短く全体を流し、TCPは開いたのに INFO を返さなかった相手だけ
   2周目で長めに待ち直す(機器のクライアントスロットが前回の探索で埋まっていて応答が遅れる場合の取りこぼし対策)。 */
const SCAN_CONC = 24, SCAN_TIMEOUT_MS = 700;
const SCAN_RETRY_CONC = 4, SCAN_RETRY_TIMEOUT_MS = 1800;

/* 要素の幅を測る(ResizeObserver)。SVG を実寸の座標で描いて、文字が伸び縮みしないようにする */
function useWidth(ref, init = 600) {
  const [w, setW] = useState(init);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((es) => { const cw = Math.round(es[0].contentRect.width); if (cw > 0) setW(cw); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}
/* 値をなめらかに追う(表示用)。target が変わると ms かけて直線で移る。STATUS は動いている間 0.25 秒ごとに届くので、
   その間を埋めてキャリッジの絵を連続して動かす(rev.39)。 */
function useGlide(target, ms = 280) {
  const [v, setV] = useState(target);
  const g = useRef({ from: target, to: target, cur: target, t0: 0, raf: 0 });
  useEffect(() => {
    const s = g.current;
    if (target === s.to) return;
    s.from = s.cur; s.to = target; s.t0 = performance.now();
    cancelAnimationFrame(s.raf);
    const tick = (now) => {
      /* rAF の時刻はフレームの始まりなので、ここで測った t0 より前のことがある。負にすると逆向きへはみ出すので 0 で止める */
      const k = Math.min(1, Math.max(0, (now - s.t0) / ms));
      s.cur = s.from + (s.to - s.from) * k;
      setV(s.cur);
      if (k < 1) s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  }, [target, ms]);
  useEffect(() => () => cancelAnimationFrame(g.current.raf), []);
  return v;
}
/* キャリッジ表示(パターンの上)。編み機のベッドを横長に描き、キャリッジがいまどこにあるか、
   次に右から左へ / 左から右へ動かすのかを矢印で示す。空通しが済んでいれば、選針区間・ポイントカム(PC1..)・
   カーソル(目1)をカーソル基準の針位置で並べる。
   ─ キャリッジの位置 (rev.39) ─
   キャリッジは実際にいる場所に置き、矢印はそこから動かす向きへ出す。右へ動かす指示は「ベッドの左側に置いたキャリッジ + 右矢印」、
   左へ動かす指示は「右側 + 左矢印」になる。位置はつねに連続させ、動いている間は左右の端へ飛ばさない:
   ・機器が針位置を合わせられているとき(st.pos) … その針位置
   ・動いていて針位置がまだ分からないとき(空通しの往路・復路、トラバースの出だし) … 動き出した位置から、
     このトラバースで数えた針(st.count)ぶん進行方向へ進める
   ・止まっていて針位置が分からないとき … いる側の端(st.side: 右端 / 左端)
   以前は動き出した瞬間に機器の「いる側」(最後に動いた向き)が行き先の端へ切り替わり、右へ動かすとすぐ右端に描かれて、
   針位置が分かると途中へ戻る、というように左右へ飛んでいた。描く位置は useGlide でなめらかに移す。
   mode: "live" = 空通しのできる機器(v3)または模擬サーバ / "none" = 未接続 / "v2" = 表示専用の機器 */
function CarriageBed({ st, calSide, mode }) {
  const boxRef = useRef(null);
  const W = Math.max(260, useWidth(boxRef, 640)), H = 100, mx = 80;
  const ok = mode === "live" && kcCalOk(st);
  const wins = ok ? st.wins : [];
  let d0 = -60, d1 = 60;
  if (wins.length) {
    const lo = Math.min(0, ...wins.map((w) => w[0])), hi = Math.max(0, ...wins.map((w) => w[1]));
    const pad = Math.max(6, Math.round((hi - lo) * 0.15));
    d0 = lo - pad; d1 = hi + pad;
  }
  const span = W - 2 * mx, step = span / (d1 - d0);
  const X = (v) => mx + (v - d0) * step;
  const startL = (mode === "live" && st ? st.start === 1 : calSide === "L");
  const live = mode === "live" && !!st;
  const moving = live && st.move > 0;
  const ph = live ? st.phase : -1;
  const cnt = live ? Math.max(0, st.count | 0) : 0;
  /* 空通しの往路・復路で動いたあと止まったとき。機器は向きが変わるまで往路・復路のままなので、次の向きは
     往路なら戻る向き(往路の端まで来たら戻す)、復路なら判定待ち(止まって 1.5 秒で判定する)として出す */
  const calStop = live && !moving && cnt > 0 && (ph === 2 || ph === 3);
  /* 動かす向き: 移動中はその向き、止まっていれば次に動かす向き。未接続なら空通しの往路の向き */
  const dirN = !live ? (startL ? 2 : 1) : moving ? st.move : calStop ? (ph === 2 ? 3 - (st.next || 1) : 0) : st.next;
  /* いる側の端(止まっているとき): 0 右端 / 1 左端 / 2 不明 */
  const sideN = live ? st.side : (startL ? 1 : 0);
  const cw = 72, ch = 26, cy = 6;
  /* キャリッジの針位置(カーソル基準)。trk に直前の位置と動きを覚え、動き出した位置から数える */
  const trk = useRef({ pos: null, move: 0, count: 0, from: null });
  const T = trk.current;
  let posN;
  if (!live) posN = startL ? d0 : d1;
  else if (ok && st.pos != null) posN = st.pos;
  else if (moving) {
    /* 新しいトラバース(向きが変わった・数え直した)は、いま描いている位置から数え始める */
    if (T.from == null || T.move !== st.move || cnt < T.count) T.from = T.pos != null ? T.pos : (st.move === 2 ? d0 : d1);
    posN = T.from + (st.move === 2 ? 1 : -1) * cnt;
  } else posN = sideN === 1 ? d0 : sideN === 0 ? d1 : (T.pos != null ? T.pos : (d0 + d1) / 2);
  posN = Math.min(d1, Math.max(d0, posN));
  T.pos = posN; T.move = moving ? st.move : 0; T.count = moving ? cnt : 0;
  if (!moving) T.from = null;
  const cx = useGlide(Math.min(W - cw / 2 - 2, Math.max(cw / 2 + 2, X(posN))));
  const lr = dirN === 1 ? "右から左へ" : dirN === 2 ? "左から右へ" : "";
  const label = mode === "v2" ? "" : !live ? `空通しは${startL ? "左端" : "右端"}から${startL ? "右" : "左"}へ`
    : moving ? `${dirN === 1 ? "左" : "右"}へ移動中`
    : calStop ? (ph === 2 ? `空通し 往路：${dirN === 1 ? "右" : "左"}端まで来たら${dirN === 1 ? "左" : "右"}へ戻す` : "空通し 復路：判定中…")
    : ph === 1 ? `空通し：${startL ? "左端" : "右端"}に置いて${dirN === 1 ? "左" : "右"}へ`
    : ph === 2 ? `空通し 往路：${dirN === 1 ? "左" : "右"}端まで`
    : ph === 3 ? `空通し 復路：${dirN === 1 ? "左" : "右"}へ戻す`
    : ph >= 4 ? `${lr}動かす` : `空通しの開始位置（${startL ? "左端" : "右端"}）`;
  const col = moving ? "#4fd18b" : ph >= 1 && ph <= 3 ? "#6cc4ff" : "#f5a623";
  /* 矢印: キャリッジの進む側へ。端で場所がなければ最低 40px */
  const room = dirN === 1 ? cx - cw / 2 - 10 : W - (cx + cw / 2) - 10;
  const L = Math.max(40, Math.min(220, room));
  const ax0 = dirN === 1 ? cx - cw / 2 - 6 : cx + cw / 2 + 6, ax1 = dirN === 1 ? ax0 - L : ax0 + L, ay = cy + ch / 2;
  /* 向きの文字は矢印の上の中央。画面からはみ出さないよう、おおよその幅(全角 13px)で内側へ寄せる。
     矢印がないとき(判定待ち)はキャリッジの横、ベッドの中央の側に出す */
  const lw = label.length * 13, lx = Math.min(W - lw / 2 - 2, Math.max(lw / 2 + 2, (ax0 + ax1) / 2));
  const nearR = cx > W / 2, lxNo = nearR ? cx - cw / 2 - 8 : cx + cw / 2 + 8;
  /* ポイントカムの番号: 往路で出会った順。右端から始めた(往路が左へ)なら区間の右端が PC1 */
  const cams = [];
  wins.forEach(([lo, hi], i) => { cams.push([startL ? lo : hi, `PC${2 * i + 1}`], [startL ? hi : lo, `PC${2 * i + 2}`]); });
  const tickStep = d1 - d0 > 160 ? 20 : 10, ticks = [];
  for (let v = Math.ceil(d0 / tickStep) * tickStep; v <= d1; v += tickStep) ticks.push(v);
  const sgn = (v) => (v > 0 ? `+${v}` : `${v}`);
  return (
    <div ref={boxRef} data-testid="kc-bed" style={{ width: "100%", minWidth: 0 }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`キャリッジ ${label}`} style={{ display: "block" }}>
        <text x={4} y={H - 4} fontSize={11} fill="#8b93a1">◀ 左</text>
        <text x={W - 4} y={H - 4} fontSize={11} fill="#8b93a1" textAnchor="end">右 ▶</text>
        {/* ベッド */}
        <rect x={X(d0)} y={58} width={span} height={10} rx={3} fill="#2a3240" stroke="#3a4352" />
        {ticks.map((v) => <line key={v} x1={X(v)} x2={X(v)} y1={68} y2={72} stroke="#4a5262" />)}
        {/* 選針区間 */}
        {wins.map(([lo, hi], i) => <rect key={i} data-testid="kc-win" x={X(lo) - step / 2} y={55} width={Math.max(2, (hi - lo + 1) * step)} height={16} rx={2} fill="rgba(245,166,35,0.30)" stroke="#f5a623" />)}
        {/* ポイントカム */}
        {cams.map(([v, n]) => (
          <g key={n}>
            <line x1={X(v)} x2={X(v)} y1={42} y2={58} stroke="#f5a623" strokeWidth={2} />
            <text x={X(v)} y={40} fontSize={10} fill="#f5a623" textAnchor="middle">{n}</text>
            <text x={X(v)} y={83} fontSize={10} fill="#aab1bd" textAnchor="middle">{sgn(v)}</text>
          </g>
        ))}
        {/* カーソル (パターンの目1) */}
        {ok && (<g data-testid="kc-cursor">
          <path d={`M ${X(0) - 6} 44 L ${X(0) + 6} 44 L ${X(0)} 54 Z`} fill="#6cc4ff" />
          <line x1={X(0)} x2={X(0)} y1={54} y2={72} stroke="#6cc4ff" strokeWidth={1.5} />
          <text x={X(0)} y={95} fontSize={10} fill="#6cc4ff" textAnchor="middle">カーソル(目1)</text>
        </g>)}
        {!ok && mode !== "v2" && <text x={W / 2} y={88} fontSize={11} fill="#5f6875" textAnchor="middle">空通しをするとポイントカムとカーソルの位置を表示します</text>}
        {mode === "v2" && <text x={W / 2} y={30} fontSize={12} fill="#8b93a1" textAnchor="middle">この機器はキャリッジの位置を送りません（表示専用）</text>}
        {/* キャリッジと動かす向き (data-cx = 描いているキャリッジの中心。試験用) */}
        {mode !== "v2" && (<g data-testid="kc-carriage-icon" data-cx={Math.round(cx)} data-dir={dirN} opacity={live ? 1 : 0.55}>
          <rect x={cx - cw / 2} y={cy} width={cw} height={ch} rx={5} fill="#3b4252" stroke={col} strokeWidth={2} />
          <text x={cx} y={cy + 17} fontSize={11} fill="#e6e9ee" textAnchor="middle">キャリッジ</text>
          {dirN > 0 && (<>
            <line x1={ax0} x2={ax1 + (dirN === 1 ? 12 : -12)} y1={ay} y2={ay} stroke={col} strokeWidth={6} />
            <path d={dirN === 1 ? `M ${ax1} ${ay} L ${ax1 + 14} ${ay - 9} L ${ax1 + 14} ${ay + 9} Z` : `M ${ax1} ${ay} L ${ax1 - 14} ${ay - 9} L ${ax1 - 14} ${ay + 9} Z`} fill={col} />
          </>)}
          {label && <text data-testid="kc-dir" x={dirN > 0 ? lx : lxNo} y={dirN > 0 ? ay - 7 : ay + 5} fontSize={13} fontWeight="bold" fill={col} textAnchor={dirN > 0 ? "middle" : nearR ? "end" : "start"} stroke="#151b24" strokeWidth={3} paintOrder="stroke">{label}</text>}
        </g>)}
      </svg>
    </div>
  );
}

function KnitControl({ doc, onClose, onRunningChange, lastConn, onConnInfo, calSide = "R", onCalSide, onDeviceBye }) {
  /* 前回つないだ機器を親から受け取る(コンポーネントはアンマウントで状態を失うため、記憶は親が持つ)。
     あれば各入力の初期値にし、開いた直後に自動で接続し直す(7.6)。 */
  const seedUrl = (lastConn && lastConn.url) || "ws://192.168.1.50:21075";
  const seedSubnet = (lastConn && lastConn.subnet) || ((seedUrl.match(/(\d+\.\d+\.\d+)\.\d+/) || [])[1] || "192.168.1");
  const seedPort = (lastConn && lastConn.port) || ((seedUrl.match(/:(\d+)/) || [])[1] || "21075");
  const autoConn = !!(lastConn && lastConn.url);
  /* 図案は色番号のまま扱う(詰め直さない)。色番号 p = 第pパスで、使っていない番号は空のパスになる。 */
  const base = doc.grid || [];
  /* 1デザイン段あたりのパス数。設定した色数と、実際に使っている最大の色番号の大きいほうを採る。
     ここを「使っている色数」だけで決めると、色数=3で色3が未使用のときに
     カード書き出し(3パス)と転送(2パス)が食い違う。docEntry() と同じ式にそろえること。 */
  const passN = useMemo(() => passCount(clamp(Math.max(maxColorNo(base), doc.colors || 0), 1, MAX_COLOR_NO)), [base, doc.colors]);
  const kcPal = useMemo(() => padPalette(doc.palette), [doc.palette]); // 編みパターン表示と対応する配色
  const [invert, setInvert] = useState(false);
  const [hflip, setHflip] = useState(false);
  const [fold, setFold] = useState(0);
  const [vx, setVx] = useState(1);
  const [hx, setHx] = useState(1);
  const [dir, setDir] = useState(KC_DIR_INIT);
  const [doneRow, setDoneRow] = useState(null);
  const [pending, setPending] = useState(null);
  const [cursor, setCursor] = useState(() => headIdx(KC_DIR_INIT, (doc.grid || []).length)); // 初期の送り方向に対応する先頭段
  const cursorRef = useRef(headIdx(KC_DIR_INIT, (doc.grid || []).length));
  const [stopped, setStopped] = useState(false);
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [loops, setLoops] = useState(0);
  const [sim, setSim] = useState(true);
  const [simSec, setSimSec] = useState(0.5);
  const [log, setLog] = useState([]);
  const [wsUrl, setWsUrl] = useState(seedUrl); // 既定ポート 21075 = ASCII"SR"(0x5253) リトルエンディアン
  const [wsState, setWsState] = useState(autoConn ? "再接続中…" : "未接続");
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState(null);
  const [subnet, setSubnet] = useState(seedSubnet);
  /* プルダウンが「直接入力」のときだけ true。候補に無い値(自動取得や手打ち)になったときも true にする。 */
  const [subnetManual, setSubnetManual] = useState(!SUBNET_PRESETS.includes(seedSubnet));
  const [port, setPort] = useState(seedPort);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState({ done: 0, total: 0 });
  const [scanNote, setScanNote] = useState(null);   // 検索の結果メッセージ(0件のときの手がかりを出す)
  /* https のページからは ws:// の接続がブラウザに禁止される(混在コンテンツ)。探索も手動接続も
     すべて失敗して「1台も見つからない」ように見えるため、判定して画面に出す。
     file:// で開いたオフライン版や http:// のページでは起きない。 */
  const insecure = typeof window !== "undefined" && window.location && window.location.protocol === "https:";
  const [found, setFound] = useState([]);
  const [detectedIp, setDetectedIp] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const subnetTouched = useRef(false);
  const scanOn = useRef(false);
  const [debug, setDebug] = useState(false); // 通信ログ/送信データ(デバッグ)の表示（初期値OFF）
  const debugRef = useRef(false);
  const [err, setErr] = useState(null);      // 転送エラー(READYタイムアウト / NAK / 接続断)の表示
  const [waitMs, setWaitMs] = useState(0);   // 応答待ちの経過時間(表示用)
  /* キャリッジ制御 (v3)。devVer = 機器が READY で返した版、cst = 機器から届いた最新の STATUS。
     版 3 以上の機器は空通しが済むまでスタートできない(needCal)。開始側(calSide)は親が持つ
     (閉じて開き直しても残す)。機器の B ボタンで開始側が変わったときは STATUS に合わせる。 */
  const [devVer, setDevVer] = useState(0);
  const [cst, setCst] = useState(null);
  const devVerRef = useRef(0), cstRef = useRef(null), calSideRef = useRef(calSide);
  useEffect(() => { calSideRef.current = calSide; }, [calSide]);
  /* 模擬サーバ(デバッグ)の STATUS。CALIB を受けると空通しの流れを返す */
  const simStRef = useRef({ phase: 0, side: 0, move: 0, next: 0, start: 0, err: 0, warn: 0, count: 0, calibrated: false, wins: [], off: 0, trav: 0 });

  const wsRef = useRef(null), timers = useRef([]), probeSockets = useRef(new Set());
  const runningRef = useRef(false), readyRef = useRef(false), pendingRef = useRef(null);
  const waitFrom = useRef(0);                // 応答を待ち始めた時刻(0 = 待っていない)
  const readyTimer = useRef(null);           // READYハンドシェイクのタイムアウト
  const retryTimer = useRef(null);           // 接続の自動再試行。clearTimers()の対象外に置く(変換操作で消さない)
  const passNRef = useRef(passN), palRef = useRef(kcPal), txRef = useRef(null);  // MODE_ENTER / ROW_DATA の v2 追記部分に使う
  const dirRef = useRef(KC_DIR_INIT), patternRef = useRef(base), kfRef = useRef(0), simRef = useRef(true), simSecRef = useRef(0.5), ctrlRef = useRef(doc.control || []), handlerRef = useRef(() => {});

  const colorPattern = useMemo(() => kcDeriveColor(base, invert, hflip, fold, passN), [base, invert, hflip, fold, passN]);
  const tx = useMemo(() => expandPassRows(colorPattern, passN, dir), [colorPattern, passN, dir]);
  const pattern = tx.rows;                        // 実際に送る段(パス段)の並び
  const designRows = colorPattern.length;         // デザイン段数(表示の段番号はこちらで数える)
  const rows = pattern.length;                    // 送出段数 = デザイン段数 × パス数
  const width = pattern[0] ? pattern[0].length : 0;
  /* 開始段の初期値は展開前の段数で作られているため、パス展開後の段数に合わせ直す。
     段数が変わる(=パターンや色数が変わる)たびに先頭段へ戻す。転送中は親側で doc が固定される。 */
  const rowsRef = useRef(0);
  useEffect(() => {
    if (rowsRef.current === rows) return;
    rowsRef.current = rows;
    const c = headIdx(dirRef.current, rows);
    setCursor(c); cursorRef.current = c;
  }, [rows]);

  const txW = width * hx, txR = rows * vx;
  const over = txW > MAX_S; // 効果目数(送出目数×横2倍)が機械上限(240)を超過
  const kf = kcKf(invert, hflip, fold, vx, hx);
  const inRange = (i) => i >= 0 && i < rows;
  /* 空通しのできる相手: つないだ機器が v3 以上、または未接続で模擬サーバ(デバッグ)を使うとき */
  const calCapable = connected ? devVer >= KC_CAL_PROTO : (sim && debug);
  const needCal = calCapable && !kcCalOk(cst);   // ポイントカム・カーソルの位置がまだ(空通しが済んでいない)
  const noDevice = !connected && !(sim && debug);
  /* スタートできない理由。ポイントカム・カーソルの位置が機器とアプリに入っていなければ、空通しが済むまでスタートさせない。
     表示専用の機器(v2)は空通しがないので従来どおり。つないだ直後で READY の版をまだ受けていないときも待つ。 */
  const startWhy = noDevice ? "編み機コントローラーに接続してください"
    : needCal ? "先に空通しをしてください（ポイントカムとカーソルの位置を機器と合わせる）"
    : connected && devVer === 0 ? "機器の応答(READY)を待っています" : null;
  const calPh = cst ? cst.phase : 0;
  const calBusy = calCapable && (calPh === 2 || calPh === 3);   // 空通しの往路・復路の途中

  useEffect(() => { patternRef.current = pattern; txRef.current = tx; }, [pattern, tx]);
  useEffect(() => { passNRef.current = passN; }, [passN]);
  useEffect(() => { palRef.current = kcPal; }, [kcPal]);
  useEffect(() => { kfRef.current = kf; }, [kf]);
  useEffect(() => { dirRef.current = dir; }, [dir]);
  useEffect(() => { simRef.current = sim; }, [sim]);
  useEffect(() => { simSecRef.current = simSec; }, [simSec]);
  useEffect(() => { debugRef.current = debug; }, [debug]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { readyRef.current = ready; }, [ready]);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { cursorRef.current = cursor; }, [cursor]);
  /* 制御4bitはパスごとに送る。第1パスはデザイン段の制御＋指示記号、第2パス以降は保持している値
     (無ければ指示記号)。ファイル書き出し・編集画面の表示と同じ passControlOf を使う。 */
  const ctrlRows = useMemo(
    () => tx.rows.map((_, i) => passControlOf(doc.control, doc.passControl, tx.design[i], tx.pass[i], passN)),
    [tx, doc.control, doc.passControl, passN]);
  useEffect(() => { ctrlRef.current = ctrlRows; }, [ctrlRows]);
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    clearTimeout(readyTimer.current); clearTimeout(retryTimer.current);
    probeSockets.current.forEach((w) => { try { w.close(); } catch (_) {} });
    /* 本接続も必ず閉じる。閉じ残すとブラウザはページが生きている間ソケットを保ち、
       機器のクライアントスロットを占有し続けるため、開き直したあとの探索・接続が通らなくなる。
       ハンドラを外してから閉じ、アンマウント後の状態更新と自動再試行が走らないようにする。 */
    const w = wsRef.current;
    /* 閉じる前に BYE を送る。M5キャリコンは意図した切断として「SRパタコン接続待ち」にする */
    if (w) { try { w.onopen = w.onclose = w.onerror = w.onmessage = null; if (w.readyState === 1) w.send(kcFrameBye()); w.close(); } catch (_) {} }
    wsRef.current = null;
  }, []);
  /* ページ(タブ)を閉じるときも BYE を送る。送ったあと自分から閉じ、BYE が閉じる手続きより先に届くようにする */
  useEffect(() => {
    const h = () => {
      const w = wsRef.current;
      if (w && w.readyState === 1) { try { w.onopen = w.onclose = w.onerror = w.onmessage = null; w.send(kcFrameBye()); w.close(1000); } catch (_) {} wsRef.current = null; }
    };
    window.addEventListener("pagehide", h);
    return () => window.removeEventListener("pagehide", h);
  }, []);
  /* 応答待ちの経過時間を0.5秒ごとに更新する(転送中のみ)。表示専用でロジックには使わない。 */
  useEffect(() => {
    if (!running) { setWaitMs(0); return; }
    const id = setInterval(() => setWaitMs(waitFrom.current ? Date.now() - waitFrom.current : 0), 500);
    return () => clearInterval(id);
  }, [running]);

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const clearReadyTimer = () => { clearTimeout(readyTimer.current); readyTimer.current = null; };
  /* 転送を異常終了させる。STOPは送らない(機器が応答しない/エラーを返した状況のため)。 */
  const failRun = (msg) => {
    clearTimers(); clearReadyTimer();
    setRunning(false); runningRef.current = false;
    setPending(null); pendingRef.current = null; setDoneRow(null); setStopped(true);
    waitFrom.current = 0; setWaitMs(0);
    setErr(msg);
  };
  const later = (fn, ms) => { const id = setTimeout(() => { timers.current = timers.current.filter((x) => x !== id); fn(); }, ms); timers.current.push(id); };
  const push = (rxtx, label, bytes) => { const bits = bytes[0] === KC_TAG.ROW_DATA ? kcBits(bytes) : null; setLog((L) => [{ d: rxtx, t: label, hex: kcHex(bytes), n: bytes.length, bits }, ...L].slice(0, 80)); };
  /* 模擬サーバの STATUS を更新して返す */
  const simSet = (patch) => { simStRef.current = { ...simStRef.current, ...patch }; handlerRef.current(kcFrameStatus(simStRef.current)); };
  /* 模擬サーバの空通し: 置く → 往路 → 復路 → 完了 を順に STATUS で返す(区間 −12〜+11、先行 0) */
  const simCalib = (side) => {
    const st = side === "L" ? 1 : 0, out = side === "L" ? 2 : 1, back = 3 - out;
    const none = { list: [], over: false }, one = { list: [0], over: false };
    simSet({ phase: 1, side: st, move: 0, next: out, start: st, err: 0, warn: 0, count: 0, calibrated: false, wins: [], off: 0, trav: 0, pos: null, curs: [none, none] });
    later(() => simSet({ phase: 2, side: 2, move: out, next: out, count: 60 }), 500);
    later(() => simSet({ phase: 3, side: 2, move: back, next: back, count: 60, curs: [one, none] }), 1100);
    later(() => simSet({ phase: 4, side: st, move: 0, next: out, count: 0, calibrated: true, wins: [[-12, 11]], curs: [one, one] }), 1700);
  };
  const emit = (bytes, label) => {
    const ws = wsRef.current, live = ws && ws.readyState === 1;
    if (live) { try { ws.send(bytes); } catch (_) {} }
    push("TX", label, bytes);
    if (!live && simRef.current && debugRef.current) {
      const tag = bytes[0];
      if (tag === KC_TAG.MODE_ENTER) later(() => { handlerRef.current(Uint8Array.from([KC_TAG.READY, KC_PROTO_VER])); handlerRef.current(kcFrameStatus(simStRef.current)); }, 150);
      else if (tag === KC_TAG.ROW_DATA) {
        const idx = bytes[1] | (bytes[2] << 8);
        const ms = Math.max(0, simSecRef.current * 1000), s1 = simStRef.current;
        if (s1.calibrated) {
          /* キャリッジを端から端へ動かす(位置 pos を 4 回に分けて送る) */
          const w = (s1.wins && s1.wins[0]) || [-12, 11], a = s1.next === 1 ? w[1] + 8 : w[0] - 8, z = s1.next === 1 ? w[0] - 8 : w[1] + 8;
          simSet({ phase: 5, move: s1.next, side: 2, pos: a });
          [1, 2, 3].forEach((k) => later(() => simSet({ pos: Math.round(a + ((z - a) * k) / 4) }), (ms * k) / 4));
        }
        later(() => {
          const s0 = simStRef.current;          // 1 パス編み終えた: 反対側へ着いて、次は逆向き
          if (s0.calibrated) {
            const w = (s0.wins && s0.wins[0]) || [-12, 11];
            simSet({ move: 0, side: s0.next === 1 ? 1 : 0, next: 3 - (s0.next || 2), trav: (s0.trav | 0) + 1, pos: s0.next === 1 ? w[0] - 8 : w[1] + 8 });
          }
          handlerRef.current(Uint8Array.from([KC_TAG.ACK, ...kcU16(idx)]));
        }, ms);
      }
      else if (tag === KC_TAG.STOP) later(() => { handlerRef.current(Uint8Array.from([KC_TAG.STOPPED])); if (simStRef.current.calibrated) simSet({ phase: 4, move: 0 }); }, 100);
      else if (tag === KC_TAG.CALIB) simCalib(bytes[1] ? "L" : "R");
    }
  };
  const announce = (pat, k) => { if (pat.length && pat[0].length) emit(kcFrameModeEnter(pat[0].length, pat.length, k, passNRef.current, palRef.current), "MODE_ENTER"); };
  const resetTx = (pat, k, d = dir) => {
    clearTimers(); clearReadyTimer(); setRunning(false); runningRef.current = false;
    setDoneRow(null); setPending(null); pendingRef.current = null; setStopped(false); setLoops(0);
    setErr(null); waitFrom.current = 0; setWaitMs(0);
    const c = headIdx(d, pat.length); setCursor(c); cursorRef.current = c;
    announce(pat, k);
  };
  const sendRow = (idx) => {
    const pat = patternRef.current, ctrl = (ctrlRef.current[idx] || 0) & 0xf;
    /* 範囲外はフレームを組めない(kcFrameRow が row.length で落ちる)。転送中のパターン差し替えは
       親側でロック済みだが、ここでも取りこぼしを止めて無言のハングを防ぐ。 */
    if (!pat[idx]) { failRun(`段の取得に失敗しました(添字${idx} / 全${pat.length}段)。パターンが変更された可能性があります`); return; }
    /* 多色: そのパス段のパス番号と色番号を末尾へ追記する(v2)。1パス(2色)はパス1・色1。 */
    const t = txRef.current, pno = (t && t.pass[idx]) || 1, cno = t && t.color[idx] != null ? t.color[idx] : 1;
    emit(kcFrameRow(idx, pat[idx], kfRef.current, ctrl, dirRef.current, pno, cno), `ROW ${idx}`);
    setPending(idx); pendingRef.current = idx;
    waitFrom.current = Date.now();               // この段のACKを待ち始めた時刻
  };
  const onAck = (idx) => {
    /* 待っている段以外のACK(重複・遅延・停止後の到着)は捨てる。受け入れると段が飛ぶ。 */
    if (pendingRef.current === null || idx !== pendingRef.current) { push("RX", `ACK ${idx} 無視`, Uint8Array.from([KC_TAG.ACK, ...kcU16(idx)])); return; }
    setDoneRow(idx); setPending(null); pendingRef.current = null; setStopped(false);
    /* dir=0(段+)は表示段番号が増える方向＝内部添字は減る方向(N = rows - i)。画面では上へ進む。dir=1 はその逆。 */
    const len = patternRef.current.length, step = dirRef.current === 0 ? -1 : 1;
    let next = idx + step, wrapped = false;
    if (next >= len) { next = 0; wrapped = true; }
    if (next < 0) { next = len - 1; wrapped = true; }
    if (wrapped) setLoops((l) => l + 1);
    setCursor(next); cursorRef.current = next;
    if (runningRef.current) sendRow(next);
    else { waitFrom.current = 0; setWaitMs(0); }
  };
  const startRun = () => {
    /* 空通しの要る機器(v3)は、済むまでスタートさせない。キャリッジの位置を機器と合わせていないため */
    if (devVerRef.current >= KC_CAL_PROTO && !kcCalOk(cstRef.current)) { setErr("先に空通しをしてください（キャリッジの「空通し」）"); return; }
    if (!wsRef.current && !(simRef.current && debugRef.current)) { setErr("編み機コントローラーに接続してください"); return; }
    clearTimers(); clearReadyTimer(); setStopped(false); setRunning(true); runningRef.current = true;
    let c = cursorRef.current;
    if (!inRange(c)) { c = headIdx(dir, rows); setCursor(c); cursorRef.current = c; }
    setDoneRow(null); setPending(null); pendingRef.current = null;
    setReady(false); readyRef.current = false;   // スタートごとに再ハンドシェイク
    setErr(null); waitFrom.current = Date.now(); setWaitMs(0);
    /* READYが返らない＝機器がいない。一定時間で諦めて止める(無言のハングを防ぐ)。 */
    readyTimer.current = setTimeout(() => {
      readyTimer.current = null;
      if (runningRef.current && !readyRef.current) failRun("READY応答なし。機器に接続されていないか、機器が応答していません");
    }, KC_READY_TIMEOUT_MS);
    announce(pattern, kf);                         // MODE_ENTER→READY 後、選択されている段(c)を最初のROW_DATAとして送信
  };
  const stopRun = () => {
    clearTimers(); clearReadyTimer(); setRunning(false); runningRef.current = false;
    emit(kcFrameStop(), "STOP"); setStopped(true); setPending(null); pendingRef.current = null; setDoneRow(null);
    setErr(null); waitFrom.current = 0; setWaitMs(0);
  };
  const toggleRun = () => (running ? stopRun() : startRun());
  /* 空通しを始める(CALIB)。機器が LCD と音声で置き場所と動かす向きを案内し、往復が済むと STATUS で
     結果(選針区間・先行)を返す。転送中はできない。 */
  const startCalib = () => {
    if (runningRef.current) return;
    setErr(null);
    emit(kcFrameCalib(calSideRef.current), `CALIB ${calSideRef.current === "L" ? "左端" : "右端"}から`);
  };
  /* 転送状態を親へ引き上げる。親はこれを見てパターンの編集・読込・目数段数変更を塞ぐ。
     アンマウント(編み機モード終了)時は必ず false を返し、ロックが残らないようにする。 */
  useEffect(() => { onRunningChange?.(running); }, [running, onRunningChange]);
  useEffect(() => () => { onRunningChange?.(false); }, [onRunningChange]);
  const handleFrame = (data) => {
    const tag = data[0];
    if (tag === KC_TAG.READY) {
      const ver = data.length > 1 ? data[1] : 1;
      clearReadyTimer(); setReady(true); readyRef.current = true; setErr(null); push("RX", `READY v${ver}`, data);
      setDevVer(ver); devVerRef.current = ver;
      /* 空通しの要る機器なのに済んでいない(スタート後に機器を入れ直した等)。送らずに止める */
      if (runningRef.current && ver >= KC_CAL_PROTO && !kcCalOk(cstRef.current)) { failRun("先に空通しをしてください（機器がキャリッジの位置を把握していません）"); return; }
      if (runningRef.current && pendingRef.current == null) sendRow(cursorRef.current);
    }
    else if (tag === KC_TAG.STATUS) {
      const st = kcParseStatus(data);
      if (!st) return;
      const prev = cstRef.current;
      cstRef.current = st; setCst(st);
      /* 通信ログは段階・不一致・警告が変わったときだけ(針カウントの更新は流さない) */
      if (!prev || prev.phase !== st.phase || prev.err !== st.err || prev.warn !== st.warn) push("RX", `STATUS ${KC_PHASE[st.phase] || st.phase}`, data);
      /* 開始側: つないだ直後は機器の値に合わせ、以後は機器側で変わったとき(B ボタン)だけ合わせる */
      const dev = st.start === 1 ? "L" : "R";
      if ((!prev || prev.start !== st.start) && dev !== calSideRef.current) { calSideRef.current = dev; onCalSide?.(dev); }
    }
    else if (tag === KC_TAG.ACK) { const idx = data[1] | (data[2] << 8); push("RX", `ACK ${idx}`, data); onAck(idx); }
    else if (tag === KC_TAG.STOPPED) push("RX", "STOPPED", data);
    /* NAKは機器からのエラー通知。以降ACKは来ないので、待ち続けずにここで止める。
       [1..2]=段番号(0xFFFF は段に属さない) / [3]=エラーコード。理由を画面とログに出す(6.3.4)。 */
    else if (tag === KC_TAG.NAK) {
      const nrow = data[1] | (data[2] << 8), code = data[3];
      const where = nrow === 0xffff ? "MODE_ENTER" : `段添字${nrow}`;
      push("RX", `NAK code${code}`, data);
      if (runningRef.current) failRun(`機器がNAKを返しました(code ${code} / ${where}): ${kcNakText(code)}`);
    }
    /* 切断要求 [85](rev.37): M5キャリコンの A+C 長押し。BYE を返して閉じ、編み機コントロールを閉じてパターン表示へ戻る。
       M5キャリコンは送信中なら編み込みを止めてから送ってくるので、STOP は送らない。 */
    else if (tag === KC_TAG.DISCONNECT) {
      push("RX", "切断要求", data);
      disconnect();
      onDeviceBye?.();
    }
  };
  handlerRef.current = handleFrame;

  /* 変換後のパス段列を組み直して再送出する。多色では反転は使えない(色とパスの対応が壊れるため)。 */
  const derived = (iv, hf, fd, d = dir) => expandPassRows(kcDeriveColor(base, iv, hf, fd, passN), passN, d).rows;
  const toggleInvert = () => {
    if (passN > 1) { setErr("多色パターンでは反転は使えません"); return; }
    const n = !invert; setInvert(n); resetTx(derived(n, hflip, fold), kcKf(n, hflip, fold, vx, hx));
  };
  const toggleHflip = () => { const n = !hflip; setHflip(n); resetTx(derived(invert, n, fold), kcKf(invert, n, fold, vx, hx)); };
  const cycleFold = () => { const n = (fold + 1) % 3; setFold(n); resetTx(derived(invert, hflip, n), kcKf(invert, hflip, n, vx, hx)); };
  const toggleVx = () => { const n = vx === 2 ? 1 : 2; setVx(n); resetTx(pattern, kcKf(invert, hflip, fold, n, hx)); };
  const toggleHx = () => { const n = hx === 2 ? 1 : 2; setHx(n); resetTx(pattern, kcKf(invert, hflip, fold, vx, n)); };
  /* 送り方向を変えると段内のパスの積み順も変わる(必ずパス1から送るため)。展開し直してから再送出する。 */
  const toggleDir = () => { const nd = dir ? 0 : 1; setDir(nd); dirRef.current = nd; resetTx(derived(invert, hflip, fold, nd), kf, nd); };
  // 開始段(編段)の手動送り/戻り・1段目リセット（停止中のみ・スタートで再開）
  /* 編成の順方向へ1段送る。段+(dir=0)では内部添字が減る側が「送る」方向＝画面では上へ進む。 */
  /* 移動の単位はパス段(送出段)1つ。多色(3色以上)では同じデザイン段の中をパスごとに動かせるので、
     「段5 パス2/3」から編み始めることができる。以前はデザイン段単位(パス数ぶん)で動かし、
     開始段を必ず第1パスへスナップさせていたが、途中のパスから編み直せないため取りやめた。
     パス番号・色番号は送出段の添字と送り方向から決まり(expandPassRows / 6.3.4)、
     機器側も同じ式で照合するので、どのパスから始めても食い違いは起きない。
     端では折り返さず範囲内にとどめる(周回はACK駆動の転送側が行う)。 */
  const stepStart = (fwd) => {
    if (running) return;
    const s = (dir === 0 ? -1 : 1) * (fwd ? 1 : -1);      // パス段1つぶん
    const c = clamp(cursor + s, 0, Math.max(0, rows - 1));
    setCursor(c); cursorRef.current = c; setDoneRow(null); setStopped(false);
  };
  const resetStart = () => { if (running) return; const c = headIdx(dir, rows); setCursor(c); cursorRef.current = c; setDoneRow(null); setStopped(false); };
  // 探索中のプローブWebSocketを全て即時クローズ（接続前に必ず呼ぶ：ソケット枯渇/機器スロット競合を防ぐ）
  const killProbes = () => { probeSockets.current.forEach((w) => { try { w.close(); } catch (_) {} }); probeSockets.current.clear(); };
  const doConnect = (url, key, retry = true) => {
    scanOn.current = false; setScanning(false);   // 接続時は走査を停止
    clearTimeout(retryTimer.current); retryTimer.current = null;
    killProbes();                                  // ★在庫の探索ソケットを全て閉じてから接続する
    let ws;
    try { ws = new WebSocket(url); } catch (_) { setWsState("エラー（模擬サーバで検証可）"); return; }
    ws.binaryType = "arraybuffer"; setWsState("接続中…"); setWsUrl(url);
    let opened = false;
    ws.onopen = () => {
      opened = true; wsRef.current = ws; setWsState("接続済み"); setConnected(true); setSelected(key || url);
      setDevVer(0); devVerRef.current = 0; setCst(null); cstRef.current = null;   // 模擬サーバ等の古い状態を消し、この機器の READY / STATUS を待つ
      setSim(false); simRef.current = false; setScanNote(null);
      /* つながった先を親へ預ける。コントロールを閉じて開き直したとき、ここへ自動で接続し直す(7.6) */
      onConnInfo?.({ url, key: key || url, subnet: String(subnet).trim().replace(/\.$/, ""), port: String(port).trim() });
      announce(pattern, kf);
    };
    ws.onclose = () => {
      const wasOpen = opened;
      if (wsRef.current === ws) wsRef.current = null;
      setConnected(false); setSelected(null); setReady(false); readyRef.current = false;
      setDevVer(0); devVerRef.current = 0; setCst(null); cstRef.current = null;
      // ★接続確立前に閉じられた場合は一度だけ自動再試行（探索直後にM5がスロットを解放しきるまでの猶予）
      //   再試行タイマーは専用refに置く。共通のtimersに載せると、変換ボタン等のclearTimers()で無言に消える。
      if (!wasOpen && retry) {
        setWsState("再接続中…");
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => { retryTimer.current = null; doConnect(url, key, false); }, 500);
      } else {
        setWsState(wasOpen ? "切断" : "未接続");
        // 確立済みの接続が転送中に切れた場合は、待ち続けても意味がないので止める
        if (wasOpen && runningRef.current) failRun("転送中に接続が切れました");
      }
    };
    ws.onerror = () => { if (opened) setWsState("エラー（模擬サーバで検証可）"); };
    ws.onmessage = (ev) => { const d = asBytes(ev.data); if (d) handlerRef.current(d); };
  };
  const connect = () => doConnect(wsUrl, wsUrl);
  const connectTo = (ip, p) => doConnect(`ws://${ip}:${p}`, `${ip}:${p}`);
  /* 切断は転送の終了でもある。runningを落とさないとボタンが「ストップ」のまま、送信先を失ったフレームが静かに捨てられる。 */
  const disconnect = () => {
    clearTimers(); clearReadyTimer();
    clearTimeout(retryTimer.current); retryTimer.current = null;
    /* 利用者の「切断」: 閉じる前に BYE を送る。M5キャリコンは「SRパタコン接続待ち」にする */
    try { const w = wsRef.current; if (w && w.readyState === 1) { w.send(kcFrameBye()); push("TX", "BYE", kcFrameBye()); } } catch (_) {}
    setRunning(false); runningRef.current = false;
    setPending(null); pendingRef.current = null; setDoneRow(null);
    setErr(null); waitFrom.current = 0; setWaitMs(0);
    try { wsRef.current && wsRef.current.close(); } catch (_) {}
    wsRef.current = null; setConnected(false); setSelected(null); setReady(false); readyRef.current = false; setWsState("未接続");
    setDevVer(0); devVerRef.current = 0; setCst(null); cstRef.current = null;
  };
  // サブネット探索：各IPへ短時間WS接続し、識別要求(0x10)に 0x90+機器名 で応答した機器を収集（排他接続の候補一覧）
  /* 戻り値は { info, opened }。info は応答があったときだけ入る。opened は TCP/WS が開いたかどうかで、
     「開いたのに INFO が返らなかった」相手を2周目で待ち直すために使う。 */
  const probe = (ip, p, timeout) => new Promise((resolve) => {
    let ws, done = false, res = null, opened = false;
    const fin = (r) => { if (done) return; done = true; if (ws) probeSockets.current.delete(ws); try { ws && ws.close(); } catch (_) {} resolve({ info: r, opened }); };
    try {
      ws = new WebSocket(`ws://${ip}:${p}`); ws.binaryType = "arraybuffer"; probeSockets.current.add(ws);
      const to = setTimeout(() => fin(null), timeout);
      ws.onopen = () => { opened = true; try { ws.send(Uint8Array.from([0x10])); } catch (_) {} };
      ws.onmessage = (ev) => {
        const d = asBytes(ev.data);
        if (d && d[0] === 0x90) { // [0x90][接続元IP 4byte][ホスト名]
          const clientIp = d.length >= 5 ? (d[1] + "." + d[2] + "." + d[3] + "." + d[4]) : null;
          const host = d.length > 5 ? new TextDecoder().decode(d.subarray(5)) : "";
          res = { name: host || ("編み機 " + ip), clientIp };
          clearTimeout(to); fin(res);
        }
      };
      ws.onerror = () => { clearTimeout(to); fin(null); };
      ws.onclose = () => { clearTimeout(to); fin(res); };
    } catch (_) { fin(null); }
  });
  /* 見つけた機器を一覧へ入れる(同じ ip:port は上書き)。1周目・2周目から共通で呼ぶ。 */
  const addFound = (ip, p, r) => {
    if (r.clientIp) setDetectedIp((prev) => prev || r.clientIp);
    setFound((fnd) => {
      const i = fnd.findIndex((x) => x.ip === ip && x.port === p);
      const dev = { ip, port: p, name: r.name, clientIp: r.clientIp, seen: Date.now() };
      if (i < 0) return [...fnd, dev];
      const nx = fnd.slice(); nx[i] = dev; return nx;
    });
  };
  /* ホスト列を並列に走査する。戻り値は { hits, silent }。silent は「開いたが無応答」のIP。 */
  const sweep = (hosts, p, conc, timeout, onProgress) => new Promise((resolve) => {
    let idx = 0, active = 0, done = 0, hits = 0; const silent = [];
    const pump = () => {
      if ((idx >= hosts.length || !scanOn.current) && active === 0) return resolve({ hits, silent });
      while (scanOn.current && active < conc && idx < hosts.length) {
        const ip = hosts[idx++]; active++;
        probe(ip, p, timeout)
          .then(({ info, opened }) => { if (info) { hits++; addFound(ip, p, info); } else if (opened) silent.push(ip); })
          .finally(() => { active--; done++; onProgress(done); pump(); });
      }
    };
    pump();
  });
  /* 「検索」押下で /24 を1回だけ走査（IPで重複排除）。走査中の再押下＝停止。ポーリングはしない。
     ・走査の前に killProbes() で在庫のプローブソケットを閉じる。閉じ残しがあると機器側の
       クライアントスロットが埋まったままになり、2回目以降の検索で1件も返らなくなる(7.3)。
     ・scanning(表示) と scanOn(判定) が食い違って固まると、押しても何も起きないボタンになるため、
       表示が「検索」に戻っているときは停止指示とみなさず、必ず新しい走査を始める。
     ・状態の後始末は finally に置き、途中で例外が出ても次の検索ができるようにする。 */
  const scanSubnet = async () => {
    if (scanOn.current && scanning) { scanOn.current = false; return; }  // 走査中の再クリック＝停止
    const base = String(subnet).trim().replace(/\.$/, ""), p = String(port).trim();
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base)) { setScanNote("サブネットは 192.168.1 のように3つの数字で指定してください"); return; }
    if (!/^\d{2,5}$/.test(p)) { setScanNote("ポート番号を確認してください（既定 21075）"); return; }
    killProbes();
    setFound([]); setScanNote(null); setScanning(true); scanOn.current = true;  // 押下ごとに一覧クリア→1回走査
    const hosts = []; for (let i = 1; i <= 254; i++) hosts.push(base + "." + i);
    const total = hosts.length;
    setScan({ done: 0, total });
    try {
      const first = await sweep(hosts, p, SCAN_CONC, SCAN_TIMEOUT_MS, (d) => setScan({ done: d, total }));
      let hits = first.hits;
      /* 2周目: TCPは開いたのに INFO を返さなかった相手だけ、長めに待ち直す */
      if (scanOn.current && first.silent.length) {
        setScan({ done: total, total, retry: first.silent.length });
        const again = await sweep(first.silent, p, SCAN_RETRY_CONC, SCAN_RETRY_TIMEOUT_MS, () => {});
        hits += again.hits;
      }
      /* TCPが開いた相手の数は切り分けの手がかりになる。
         0件なら走査したサブネットに誰もいない(＝サブネット違い / 別のLAN / 機器が起動していない)。
         1件以上あるのに見つからないなら、そのポートで別のものが動いている可能性が高い。 */
      const openedCount = hits + first.silent.length;
      if (!scanOn.current) setScanNote("検索を中止しました");
      else if (hits) setScanNote(`${base}.1〜254 で ${hits} 台見つかりました`);
      else setScanNote(`${base}.1〜254 / ポート${p} では見つかりませんでした`
        + `（ポート${p}が開いていた相手 ${openedCount} 件）。`
        + (insecure
            ? `このページは https で開かれているため、ブラウザが ws:// の接続を禁止しています。`
              + `オフライン版のファイルを直接開くか、http:// で開いてください。`
            : openedCount === 0
              ? `走査したサブネットには応答する相手がいません。PCと機器が同じLANにあるか（ゲストSSIDやAP隔離に注意）、`
                + `機器の電源とWiFi接続、サブネットの選択を確認してください。`
                + `機器が設定ポータル（AP「KnitCtrl-XXXX」）に入っているときは 192.168.4 を直接入力して探します。`
              : `ポート${p}では応答がありました。ポート番号が別のサービスと重なっていないか確認してください。`)
        + `機器のIPが分かっているときは下の「手動」に ws://IP:${p} を入れて接続できます。`);
    } finally {
      setScanning(false); scanOn.current = false;
    }
  };
  /* サブネットの選択を反映する。候補にある値はプルダウン、無い値は「直接入力」に切り替える。 */
  const applySubnet = (v, touched = true) => {
    const b = String(v).trim().replace(/\.$/, "");
    setSubnet(b);
    setSubnetManual(!SUBNET_PRESETS.includes(b));
    if (touched) subnetTouched.current = true;
  };
  const onSubnetSelect = (v) => {
    if (v === SUBNET_MANUAL) { setSubnetManual(true); subnetTouched.current = true; return; }
    setSubnet(v); setSubnetManual(false); subnetTouched.current = true; setScanNote(null);
  };
  // シード（手動URL）のArduinoへ問い合わせ、接続元IP→サブネットを取得
  const seedProbe = () => {
    const host = (wsUrl.match(/\/\/([^:/]+)/) || [])[1];
    const sp = (wsUrl.match(/:(\d+)/) || [])[1] || port;
    if (!host) return Promise.resolve(null);
    return probe(host, sp, 1500);
  };
  const autoSubnet = async () => {
    setDetecting(true); const res = await seedProbe(); setDetecting(false);
    const r = res && res.info;
    if (r && r.clientIp) { const q = r.clientIp.split("."); applySubnet(q[0] + "." + q[1] + "." + q[2]); setDetectedIp(r.clientIp); }
    else setDetectedIp("取得不可");
  };
  /* 開いた直後の自動再接続。前回つないだ先が分かっているときだけ1回試し、
     つながらなければ通常の検索段に戻る(doConnect が500ms後に一度だけ再試行する)。 */
  useEffect(() => {
    if (!autoConn) return;
    setScanNote(`前回つないだ ${lastConn.key || lastConn.url} へ自動接続しています。`
      + `つながらないときは「検索」か下の「手動」で接続してください。`);
    doConnect(lastConn.url, lastConn.key || lastConn.url);
  }, []);
  useEffect(() => { // 起動時：手動URLのArduinoから接続元IPを取得しサブネット初期値に
    if (autoConn) return;              // 自動再接続を試すので、シードの問い合わせはしない
    let alive = true;
    seedProbe().then((res) => {
      const r = res && res.info;
      if (!alive || !r || !r.clientIp) return;
      setDetectedIp(r.clientIp);
      if (!subnetTouched.current) { const q = r.clientIp.split("."); applySubnet(q[0] + "." + q[1] + "." + q[2], false); }
    });
    return () => { alive = false; };
  }, []);
  const outbound = useMemo(() => {
    const mb = kcFrameModeEnter(width, rows, kf, passN, kcPal);
    const list = [{ label: "MODE_ENTER", hex: kcHex(mb), n: mb.length, bits: null }];
    const lim = Math.min(rows, 40);
    for (let i = 0; i < lim; i++) {
      const b = kcFrameRow(i, pattern[i], kf, ctrlRows[i] || 0, dir, tx.pass[i], tx.color[i]);
      list.push({ label: passN > 1 ? `ROW ${i}（段${designRows - tx.design[i]} パス${tx.pass[i]}${tx.color[i] === 0 ? "=地色" : ""}）` : `ROW ${i}`, hex: kcHex(b), n: b.length, bits: kcBits(b) });
    }
    return { list, more: rows - lim };
  }, [pattern, width, rows, kf, dir, doc, ctrlRows, tx, passN, designRows, kcPal]);

  /* ---- パターン＋段状態のCanvas描画（性能：パターンはオフスクリーン、状態着色はオンスクリーン）---- */
  const cell = 6;
  const patC = useRef(null), viewRef = useRef(null);
  useEffect(() => {
    if (!width || !rows) return;
    const off = patC.current || (patC.current = document.createElement("canvas"));
    off.width = width * cell; off.height = rows * cell;
    const ctx = off.getContext("2d");
    ctx.fillStyle = "#171a20"; ctx.fillRect(0, 0, off.width, off.height);
    /* 編み機コントロールも表示モードと同じ向きで描く(段1=最下段)。内部インデックスy がそのまま表示行。
       配色は編みパターン表示と対応させる: 選針された目はそのパスの色。
       ─ 非選針の目 ─
       ・2色(1パス)は非選針がそのまま地色で編まれるので、表示モードと同じ地色(色0)をそのまま敷く。
       ・3色以上は最終パス(地色の柄)で編まれる目が地色になる。各パスの非選針は「このパスでは編まない」
         という意味でしかないため、地色を大きく暗くした色で敷いて、地色そのものと見分けられるようにする。 */
    const dimGround = shade(kcPal[0] || "#FFFFFF", -0.86);
    const groundCol = passN < 2 ? (kcPal[0] || "#FFFFFF") : dimGround;
    for (let y = 0; y < rows; y++) {
      const row = pattern[y], on = kcPal[tx.color[y]] || "#cfd4dc";
      for (let x = 0; x < width; x++) { ctx.fillStyle = row[x] ? on : groundCol; ctx.fillRect(x * cell, y * cell, cell, cell); }
    }
    /* 5目・5段ごとの目安線。2色で明るい地色を敷いたときは白い線が見えないので暗い線にする */
    ctx.strokeStyle = passN < 2 && luminance(kcPal[0] || "#FFFFFF") > 0.55 ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.06)";
    ctx.beginPath();
    for (let x = 0; x <= width; x += 5) { ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, rows * cell); }
    for (let y = 0; y <= rows; y += 5) { ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(width * cell, y * cell + 0.5); }
    ctx.stroke();
  }, [pattern, width, rows, tx, kcPal, passN]);
  useEffect(() => {
    const cv = viewRef.current; if (!cv || !patC.current || !width || !rows) return;
    cv.width = width * cell; cv.height = rows * cell;
    const ctx = cv.getContext("2d");
    ctx.drawImage(patC.current, 0, 0);
    const tint = (i, color) => { if (i == null || i < 0 || i >= rows) return; ctx.fillStyle = color; ctx.fillRect(0, i * cell, width * cell, cell); }; // 内部添字=表示行(段1が最下段)
    tint(doneRow, "rgba(168,85,247,0.5)");           // 転送済み(紫・直近1段)
    if (running) {
      tint(pending, "rgba(74,158,255,0.5)");           // 送信中(青・ACK待ち)
    }
    /* 多色: 編んでいるデザイン段(=nパス分)を赤枠で囲む。枠の中の着色された段が、いま編んでいるパス。 */
    if (passN > 1) {
      const focus = pending != null ? pending : (doneRow != null ? doneRow : cursor);
      if (focus >= 0 && focus < rows) {
        const d = tx.design[focus];
        let top = focus, bot = focus;
        while (top > 0 && tx.design[top - 1] === d) top--;
        while (bot < rows - 1 && tx.design[bot + 1] === d) bot++;
        ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = 2;
        ctx.strokeRect(1, top * cell + 1, width * cell - 2, (bot - top + 1) * cell - 2);
      }
    }
    if (!running && cursor >= 0 && cursor < rows) {
      // 停止/待機：保持中の開始段を枠マーカーで明示（ストップで編段を保持）
      const dyc = cursor * cell;
      ctx.fillStyle = "rgba(245,166,35,0.24)"; ctx.fillRect(0, dyc, width * cell, cell);
      ctx.strokeStyle = "#f5a623"; ctx.lineWidth = 2; ctx.strokeRect(1, dyc + 1, width * cell - 2, cell - 2);
    }
  }, [pattern, width, rows, cursor, pending, doneRow, stopped, running, tx, passN]);

  /* 表示段番号はデザイン段で数える(段1=最下段)。多色ではパス番号も併記する。 */
  const rowNo = (i) => (i == null || i < 0 || i >= rows ? "-" : designRows - tx.design[i]);
  const passOf = (i) => (i == null || i < 0 || i >= rows ? 1 : tx.pass[i]);
  const withPass = (i) => (passN > 1 ? `段${rowNo(i)} パス${passOf(i)}/${passN}` : `段${rowNo(i)}`);
  const status = running
    ? (pending !== null ? `${withPass(pending)} ACK待ち` : ready ? `送出中 ${withPass(cursor)}` : "READY待ち")
    : `${stopped ? "停止中" : "待機"}・開始段=${withPass(cursor)}`;
  /* 応答待ちが長引いていることを見えるようにする。ACKはキャリッジ操作待ちで正常に長くなるので、時間では止めない。 */
  const waiting = running && waitMs >= KC_WAIT_SHOW_MS;
  const waitAlert = waitMs >= KC_WAIT_ALERT_MS;
  const cap = { fontSize: 10, lineHeight: 1 };
  const iconBtn = (active, accent) => ({ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, padding: "8px 6px", borderRadius: 6, border: "1px solid", ...(active ? { background: accent, color: "#12141a", borderColor: accent } : { background: "#232833", color: "#d7dbe2", borderColor: "#333a46" }), opacity: running ? 0.45 : 1, cursor: running ? "not-allowed" : "pointer" });
  const mono = { fontFamily: "ui-monospace, monospace", fontSize: 11, lineHeight: 1.5 };

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "#12141a", color: "#d7dbe2", fontFamily: "system-ui, sans-serif" }}>
      <header className="flex items-center gap-3 px-3 py-2 border-b shrink-0" style={{ borderColor: "#2a2f38", background: "#171a20" }}>
        <span className="text-sm font-semibold" style={{ color: "#e8ebf0" }}><span style={{ color: "#f5a623" }}>▚</span> 編み機コントロール<span title={`SRパタコン ${APP_REV}（${APP_DATE}）`} style={{ marginLeft: 8, padding: "1px 7px", fontSize: 11, fontWeight: 600, color: "#fff", background: "#111", border: "1px solid #5f6875", borderRadius: 4, verticalAlign: "1px" }}>{APP_REV}</span></span>
        <span className="text-xs" style={{ color: "#8b93a1" }}>表示 {width}×{rows}{(hx === 2 || vx === 2) ? ` ／送出 ${txW}×${txR}` : ""}</span>
        {over && <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(220,60,60,.18)", color: "#f28b8b" }}>⚠ 効果目数 {txW} ＞ {MAX_S}目（変換を調整）</span>}
        {err && <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(220,60,60,.18)", color: "#f28b8b", border: "1px solid #7a3535" }}>⚠ {err}</span>}
        <div className="flex-1" />
        {waiting && <span className="text-xs px-2 py-0.5 rounded" style={{ background: waitAlert ? "rgba(220,60,60,.15)" : "rgba(201,154,91,.15)", color: waitAlert ? "#f28b8b" : "#c99a5b" }}>応答待ち {Math.floor(waitMs / 1000)}秒</span>}
        <span className="text-xs" style={{ color: "#8b93a1" }}>{status}・周回 {loops}</span>
        {connected && (<>
          <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(47,107,79,.25)", color: "#7ee0a8", border: "1px solid #2f6b4f" }}>● 接続中：{selected || wsUrl}{ready ? " / READY✓" : ""}</span>
          <button onClick={disconnect} className="h-8 px-3 rounded text-xs font-medium" style={{ background: "#8a3b3b", color: "#fff" }}>切断</button>
        </>)}
        <button onClick={() => setDebug((v) => !v)} className="h-8 px-3 rounded text-xs" style={debug ? { background: "#3a4150", color: "#e6e9ee" } : { background: "#232833", color: "#8b93a1", border: "1px solid #333a46" }} title="通信ログ/送信データ(デバッグ)の表示切替">デバッグ{debug ? " ▾" : " ▸"}</button>
        <button onClick={onClose} className="h-8 px-3 rounded text-xs font-medium" style={{ background: "#333a46", color: "#c8cdd6" }}>閉じる</button>
      </header>
      {/* 編み機コントローラー検索段：接続中は非表示（切断で再表示） */}
      {!connected && (
      <div className="flex flex-col gap-1.5 px-3 py-2 border-b shrink-0" style={{ borderColor: "#2a2f38", background: "#1b2330" }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold" style={{ color: "#8b93a1" }}>編み機コントローラー<span style={{ marginLeft: 4, fontWeight: 400, color: "#5f6875" }}>{APP_REV}</span></span>
          <label className="flex items-center gap-1 text-xs" style={{ color: "#aab1bd" }}>
            サブネット
            {/* プライベートIPの候補から選ぶ。候補に無い /24 は「直接入力」で打ち込む */}
            <select value={subnetManual ? SUBNET_MANUAL : subnet} onChange={(e) => onSubnetSelect(e.target.value)} disabled={connected || scanning}
              title="検索する /24 を選ぶ。PCと同じLANのサブネットを選んでください（候補に無いときは「直接入力」）"
              className="h-8 px-1 rounded text-xs disabled:opacity-40" style={{ background: "#232833", border: "1px solid #333a46", color: "#e6e9ee" }}>
              {SUBNET_PRESETS.map((s) => <option key={s} value={s}>{s}.x</option>)}
              <option value={SUBNET_MANUAL}>直接入力</option>
            </select>
            {subnetManual && (<>
              <input value={subnet} onChange={(e) => { setSubnet(e.target.value); subnetTouched.current = true; setScanNote(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") scanSubnet(); }} disabled={connected || scanning} placeholder="192.168.11"
                className="h-8 px-2 rounded disabled:opacity-40" style={{ width: 110, ...mono, background: "#232833", border: "1px solid #333a46", color: "#e6e9ee" }} />. x
            </>)}
            <button onClick={autoSubnet} disabled={connected || detecting} className="h-8 px-2 rounded text-xs disabled:opacity-40" title="手動URLの機器に問い合わせ、接続元IPからサブネットを自動設定" style={{ background: "#333a46", color: "#d7dbe2" }}>{detecting ? "取得中…" : "自動"}</button>
            {detectedIp && <span style={{ color: detectedIp === "取得不可" ? "#c99a5b" : "#7ee0a8" }}>{detectedIp === "取得不可" ? "PC-IP取得不可(手動入力)" : "PC:" + detectedIp}</span>}
          </label>
          <label className="flex items-center gap-1 text-xs" style={{ color: "#aab1bd" }}>
            ポート<input value={port} onChange={(e) => setPort(e.target.value)} disabled={connected} className="w-16 h-8 px-2 rounded" style={{ ...mono, background: "#232833", border: "1px solid #333a46", color: "#e6e9ee" }} />
          </label>
          {insecure && <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(220,60,60,.18)", color: "#f28b8b", border: "1px solid #7a3535" }} title="https のページからは ws:// の接続がブラウザに禁止されます。オフライン版を直接開くか http:// で開いてください">⚠ https 表示中（ws:// 接続不可）</span>}
          <button onClick={scanSubnet} disabled={connected} className="h-8 px-3 rounded text-xs font-medium disabled:opacity-40" style={{ background: scanning ? "#7a4a1f" : "#2f6b4f", color: "#fff" }}>{scanning ? ("停止 " + (scan.retry ? `再確認${scan.retry}件` : scan.done + "/" + scan.total)) : "検索"}</button>
          <div className="flex-1" />
          {debug && (<>
          <label className="flex items-center gap-1.5 text-xs" style={{ color: "#aab1bd" }}>
            <input type="checkbox" checked={sim} onChange={(e) => { setSim(e.target.checked); simRef.current = e.target.checked; }} />模擬サーバ
          </label>
          <label className="flex items-center gap-1.5 text-xs" style={{ color: "#aab1bd" }}>
            ACK待ち<input type="number" step="0.1" min="0" value={simSec} onChange={(e) => { const v = Number(e.target.value); const s = isNaN(v) ? 0 : v; setSimSec(s); simSecRef.current = s; }} className="w-14 h-8 px-2 rounded" style={{ ...mono, background: "#232833", border: "1px solid #333a46", color: "#e6e9ee" }} />秒
          </label>
          </>)}
          <span data-testid="kc-wsstate" className="text-xs" style={{ color: connected ? "#7ee0a8" : "#8b93a1" }}>状態：{wsState}{ready ? " / READY✓" : ""}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {found.length === 0 && (
            <span className="flex items-center gap-1 text-xs" style={{ color: "#8b93a1" }}>
              {scanning ? "探索中… " : "未検出　"}手動：<input value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} disabled={connected} className="h-7 px-2 rounded" style={{ width: 200, ...mono, background: "#232833", border: "1px solid #333a46", color: "#e6e9ee" }} />
              <button onClick={connect} disabled={connected} className="h-7 px-3 rounded text-xs disabled:opacity-40" style={{ background: "#333a46", color: "#d7dbe2" }}>接続</button>
            </span>
          )}
          {found.map((d) => {
            const key = d.ip + ":" + d.port, isSel = selected === key;
            return (
              <button key={key} onClick={() => (isSel && connected ? null : connectTo(d.ip, d.port))} disabled={connected && !isSel}
                className="h-8 px-3 rounded text-xs font-medium disabled:opacity-40" title={d.name + " (" + key + ")"}
                style={isSel && connected ? { background: "#2f6b4f", color: "#fff", border: "1px solid #3f8b63" } : { background: "#232833", color: "#d7dbe2", border: "1px solid #333a46" }}>
                {isSel && connected ? "● 接続中：" : ""}{d.name} <span style={{ opacity: 0.7 }}>({key})</span>
              </button>
            );
          })}
          {scanning && <span className="text-xs" style={{ color: "#c99a5b" }}>検索中… {scan.retry ? `応答待ちを再確認 ${scan.retry}件` : `${scan.done}/${scan.total}`}</span>}
        </div>
        {/* 検索結果のメッセージ。0件のときは確認すべき点を出す(黙って何も起きないのを防ぐ) */}
        {scanNote && !scanning && (
          <div className="text-xs" style={{ color: found.length ? "#7ee0a8" : "#c99a5b" }}>{scanNote}</div>
        )}
      </div>
      )}

      {/* コントロール */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b shrink-0" style={{ borderColor: "#2a2f38", background: "#171a20" }}>
        <div className="flex gap-1">
          <button disabled={running} onClick={toggleInvert} style={iconBtn(false)}><Icon bmp={invert ? KC_ICON.invert : KC_ICON.orig} /><span style={cap}>反転</span></button>
          <button disabled={running} onClick={toggleHflip} style={iconBtn(false)}><Icon bmp={hflip ? KC_ICON.hflip : KC_ICON.orig} /><span style={cap}>左右反転</span></button>
          <button disabled={running} onClick={cycleFold} style={iconBtn(fold !== 0, "#8b5cf6")}><Icon bmp={fold === 0 ? KC_ICON.orig : fold === 1 ? KC_ICON.mirror : KC_ICON.chevron} frame={fold === 0} /><span style={cap}>折返し:{KC_FOLD[fold]}</span></button>
        </div>
        <span className="w-px h-8" style={{ background: "#333a46" }} />
        <div className="flex gap-1">
          <button disabled={running} onClick={toggleVx} style={iconBtn(vx === 2, "#6366f1")}><Icon bmp={KC_ICON.vscale} /><span style={cap}>縦2倍{vx === 2 ? " ×2" : ""}</span></button>
          <button disabled={running} onClick={toggleHx} style={iconBtn(hx === 2, "#6366f1")}><Icon bmp={KC_ICON.hscale} /><span style={cap}>横2倍{hx === 2 ? " ×2" : ""}</span></button>
        </div>
        <span className="w-px h-8" style={{ background: "#333a46" }} />
        <button onClick={toggleDir} disabled={running} className="h-9 px-3 rounded text-xs font-medium disabled:opacity-40" style={{ background: "#232833", color: "#d7dbe2", border: "1px solid #333a46" }}>
          送り方向：{dir === 0 ? "上向き(段+)" : "下向き(段−)"}
        </button>
        <span className="text-xs px-1 font-semibold" style={{ color: "#f5a623" }}>開始 {withPass(cursor)}</span>
        <span className="w-px h-8" style={{ background: "#333a46" }} />
        {/* 空通し: 開始側(右端/左端)を選んで押す。送信中は押せず、ストップすると押せる(位置の再設定) */}
        <div className="flex items-center gap-1">
          <span className="text-xs" style={{ color: "#8b93a1" }}>開始側</span>
          <div className="flex rounded overflow-hidden" style={{ border: "1px solid #333a46" }}>
            {/* 編み機と同じ並び: 左に「左端」、右に「右端」 */}
            {[["L", "左端"], ["R", "右端"]].map(([v, label]) => (
              <button key={v} onClick={() => onCalSide?.(v)} disabled={running || calBusy} aria-pressed={calSide === v}
                title={`空通しをキャリッジの${label}から始める`} className="h-9 px-2 text-xs font-medium disabled:opacity-40"
                style={calSide === v ? { background: "#f5a623", color: "#1d1d1d" } : { background: "#232833", color: "#d7dbe2" }}>{label}</button>
            ))}
          </div>
        </div>
        <button data-testid="kc-calib" onClick={startCalib} disabled={!calCapable || running || calBusy}
          title={!calCapable ? (connected ? "この機器は空通しに対応していません（表示専用）" : "編み機コントローラーに接続すると使えます")
            : running ? "送信中は空通しできません（ストップすると押せます）"
            : "キャリッジを往復させてポイントカムとカーソルの位置を確かめる。機器が表示と音声で案内します"}
          className="h-9 px-4 rounded text-sm font-bold disabled:opacity-40"
          style={calCapable && kcCalOk(cst) ? { background: "#333a46", color: "#d7dbe2", border: "1px solid #444c5c" } : { background: "#f5a623", color: "#1d1d1d" }}>
          {calBusy ? "空通し中…" : calCapable && kcCalOk(cst) ? "空通し ✓" : "空通し"}
        </button>
        <button data-testid="kc-start" onClick={toggleRun} disabled={(over && !running) || (!running && !!startWhy)} title={!running && startWhy ? startWhy : undefined} className="h-9 px-5 rounded text-sm font-bold disabled:opacity-40" style={{ background: running ? "#dc4b4b" : "#2fa968", color: "#fff" }}>
          {running ? "■ ストップ" : "▶ スタート"}
        </button>
        <button onClick={() => stepStart(true)} disabled={running} title={`開始段を送る（順方向・${dir === 0 ? "段+" : "段−"}）。${passN > 1 ? "パス段1つぶん動く" : "1段ぶん動く"}`} className="h-11 w-12 flex items-center justify-center rounded text-2xl font-bold disabled:opacity-40" style={{ background: "#232833", color: "#d7dbe2", border: "1px solid #333a46" }}>{dir === 0 ? "▲" : "▼"}</button>
        <button onClick={() => stepStart(false)} disabled={running} title={`開始段を戻す（逆方向・${dir === 0 ? "段−" : "段+"}）。${passN > 1 ? "パス段1つぶん動く" : "1段ぶん動く"}`} className="h-11 w-12 flex items-center justify-center rounded text-2xl font-bold disabled:opacity-40" style={{ background: "#232833", color: "#d7dbe2", border: "1px solid #333a46" }}>{dir === 0 ? "▼" : "▲"}</button>
        <button onClick={resetStart} disabled={running} title="開始段を1段目にリセット" className="h-9 px-3 rounded text-xs font-medium disabled:opacity-40" style={{ background: "#232833", color: "#d7dbe2", border: "1px solid #333a46" }}>⟲ 1段目</button>
      </div>

      {/* キャリッジ表示(パターンの上): 次に編む段(大きく)、キャリッジの位置と動かす向き、ポイントカム・カーソル、空通しの状態 */}
      {(() => {
        const st = calCapable ? cst : null, ok = kcCalOk(st), ph = st ? st.phase : 0;
        const nextIdx = running ? (pending != null ? pending : cursor) : cursor;
        const nextCol = passN > 1 && inRange(nextIdx) ? kcPal[tx.color[nextIdx]] : null;
        const mode = calCapable ? "live" : connected && devVer > 0 ? "v2" : connected ? "none" : "none";
        const tone = !calCapable ? "#8b93a1" : !st ? "#8b93a1" : ph >= 4 ? "#7ee0a8" : ph === 1 ? "#f5a623" : ph >= 2 ? "#6cc4ff" : "#8b93a1";
        const guide = noDevice ? "編み機コントローラーに接続してください（空通しのあとでスタートできます）"
          : mode === "v2" ? "表示専用の機器です（空通しなしで送ります）" : kcGuide(st, calSide);
        return (
          <div data-testid="kc-carriage" className="flex flex-col gap-1 px-3 py-2 border-b shrink-0" style={{ borderColor: "#2a2f38", background: "#151b24" }}>
            <div className="flex flex-wrap items-stretch gap-3">
              <div data-testid="kc-nextrow" className="flex flex-col justify-center px-3 py-1 rounded shrink-0" style={{ background: "#1d2430", border: "1px solid #333a46", minWidth: 132 }}>
                <span className="text-xs" style={{ color: "#8b93a1" }}>{running ? "次に編む段" : "次に編む段（開始段）"}</span>
                <span className="font-bold" style={{ fontSize: 34, lineHeight: 1.1, color: "#f5a623" }}>段 {rowNo(nextIdx)}</span>
                <span className="flex items-center gap-1 text-xs" style={{ color: "#aab1bd" }}>
                  {nextCol && <i style={{ width: 10, height: 10, background: nextCol, border: "1px solid #5f6875", borderRadius: 2, display: "inline-block" }} />}
                  {passN > 1 ? `パス ${passOf(nextIdx)}/${passN}・` : ""}全 {designRows} 段
                </span>
              </div>
              {/* 狭い画面では次に編む段の下へ回り込む */}
              <div style={{ flex: "1 1 300px", minWidth: 0 }}><CarriageBed st={st} calSide={calSide} mode={mode} /></div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="kc-phase" className="text-xs px-2 py-0.5 rounded font-semibold" style={{ color: tone, border: `1px solid ${tone}` }}>{!calCapable ? (mode === "v2" ? "表示専用" : "未接続") : st ? KC_PHASE[ph] || `段階${ph}` : "未較正"}</span>
              <span data-testid="kc-guide" className="text-xs" style={{ color: "#d7dbe2" }}>{guide}</span>
              <div className="flex-1" />
              {st && calCapable && <span className="text-xs" style={{ color: "#8b93a1" }}>キャリッジ：{st.move ? `${kcDirText(st.move)}移動中・針 ${st.count}` : (KC_SIDE[st.side] || "不明")}</span>}
              {ok && <span data-testid="kc-result" className="text-xs" style={{ color: "#8b93a1" }} title="カーソル(パターンの目1)を0とした針位置。右が+">選針区間 {st.wins.map(([lo, hi]) => `${lo}〜${hi}（${hi - lo + 1}目）`).join("・")}／先行 {st.off}目{st.pc3 ? "／ポイントカム3は無視" : ""}{ph === 5 ? `／編んだパス ${st.trav}` : ""}</span>}
              {st && st.err !== 0 && ph <= 1 && <span data-testid="kc-err" className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(220,60,60,.18)", color: "#f28b8b", border: "1px solid #7a3535" }}>不一致：{kcBitsText(st.err, KC_CAL_ERR)}。もう一度空通ししてください</span>}
              {/* 空通しで検知したカーソル(rev.34 の機器)。往路・復路それぞれ最初に検知したカーソルを 0 とし、2 つめ以降は進行方向へ何目あとか。
                  1 つずつなら正常。2 つ以上なら赤で出す(+1目なら同じパルスの数え直し、離れていればカーソルが本当に 2 つある) */}
              {st && st.curs && ph >= 1 && ph <= 4 && (st.curs[0].list.length > 0 || st.curs[1].list.length > 0) && (() => {
                const multi = st.curs.some((c) => c.list.length > 1 || c.over);
                const outA = st.start === 1 ? "→" : "←", backA = st.start === 1 ? "←" : "→";
                return (
                  <span data-testid="kc-cursors" className="text-xs px-2 py-0.5 rounded"
                    title="空通しで検知したカーソル(IN1)。往路・復路それぞれ、最初に検知したカーソルを 0 とし、2 つめ以降はそこから進行方向へ何目あとか(INP の数)を示す。スタート・反転時のパルスは含まない。往復とも 1 つずつなら正常"
                    style={multi ? { background: "rgba(220,60,60,.18)", color: "#f28b8b", border: "1px solid #7a3535" } : { color: "#8b93a1", border: "1px solid #333a46" }}>
                    カーソル検知 往路{outA} {kcCurText(st.curs[0])} ／ 復路{backA} {kcCurText(st.curs[1])}
                  </span>);
              })()}
              {st && st.warn !== 0 && ph === 5 && <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(201,154,91,.15)", color: "#c99a5b" }}>⚠ {kcBitsText(st.warn, KC_WARN)}</span>}
            </div>
          </div>
        );
      })()}

      {/* 本体：パターン(状態着色) 全幅 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-3 px-3 py-1 text-xs shrink-0" style={{ color: "#8b93a1" }}>
          <span className="flex items-center gap-1"><i style={{ width: 10, height: 10, background: "rgba(168,85,247,.75)", borderRadius: 2, display: "inline-block" }} />転送済み(直近1段)</span>
          <span className="flex items-center gap-1"><i style={{ width: 10, height: 10, background: "rgba(74,158,255,.7)", borderRadius: 2, display: "inline-block" }} />送信中</span>
          <span className="flex items-center gap-1"><i style={{ width: 10, height: 10, background: "rgba(245,166,35,.7)", borderRadius: 2, display: "inline-block" }} />開始段(保持・枠)</span>
        </div>
        <div className="flex-1 overflow-auto p-3" style={{ minHeight: 0 }}>
          <canvas ref={viewRef} style={{ display: "block", imageRendering: "pixelated", borderRadius: 4, boxShadow: "0 2px 14px rgba(0,0,0,.5)" }} />
        </div>
      </div>

      {/* デバッグ：通信ログ / 送信データ（最下部・左右2ペイン・非表示可） */}
      {debug && (
        <div className="flex shrink-0 border-t" style={{ height: 220, borderColor: "#2a2f38", background: "#14161c" }}>
          <div className="flex-1 min-w-0 flex flex-col border-r" style={{ borderColor: "#2a2f38" }}>
            <div className="px-3 py-1.5 text-xs font-bold shrink-0" style={{ color: "#8b93a1", background: "#171a20" }}>通信ログ（TX/RX・hex）</div>
            <div className="overflow-auto p-2 flex-1" style={{ ...mono, background: "#0e1014", color: "#d7dbe2" }}>
              {log.length === 0 && <div style={{ color: "#5a6270" }}>— スタートで通信が始まります —</div>}
              {log.map((e, i) => (
                <div key={i}>
                  <div><span style={{ color: e.d === "TX" ? "#f5a623" : "#4fd18b", marginRight: 4 }}>{e.d}</span><span style={{ color: "#8b93a1" }}>{e.t.padEnd(11)}</span>{e.hex} <span style={{ color: "#5a6270" }}>({e.n}B)</span></div>
                  {e.bits && <div style={{ color: "#6cc4ff", paddingLeft: 24, letterSpacing: 1 }}>{e.bits}</div>}
                </div>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-3 py-1.5 text-xs font-bold shrink-0" style={{ color: "#8b93a1", background: "#171a20" }}>送信データ一覧（現設定で送る全フレーム）</div>
            <div className="overflow-auto p-2 flex-1" style={{ ...mono, background: "#0e1014" }}>
              {outbound.list.map((e, i) => (
                <div key={i}>
                  <div style={i === 0 ? { color: "#b794f6" } : { color: "#cfd4dc" }}><span style={{ color: "#8b93a1", display: "inline-block", width: 88 }}>{e.label}</span>{e.hex} <span style={{ color: "#5a6270" }}>({e.n}B)</span></div>
                  {e.bits && <div style={{ color: "#6cc4ff", paddingLeft: 88, letterSpacing: 1 }}>{e.bits}</div>}
                </div>
              ))}
              {outbound.more > 0 && <div style={{ color: "#5a6270" }}>… 以降 {outbound.more} 段（全 {rows} 段）</div>}
            </div>
            <div className="text-xs px-2 py-1 shrink-0" style={{ color: "#5a6270" }}>ROW_DATA=[02 段番号LE kf ctrl dir 目数LE 目ビット列 パス番号 色番号]（末尾2byteはv2）。目ビットは左端(目1)=bit0・LSB→MSB。CALIB=[04 開始側]・BYE=[05]・STATUS=[84 …40byte]（v3）・切断要求=[85]。</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================== App ============================== */

export default function KnitPatternMaker() {
  const [doc, setDoc] = useState(() => ({
    stitches: 24, rows: 60,
    palette: DEFAULT_PALETTE.slice(),
    grid: mkGrid(60, 24, 0),
    control: Array(60).fill(0), // デザイン段ごとの制御4bit(0..15)=第1パス(色1層)の制御
    passControl: [],            // 段ごと・パスごとの制御4bit。第2パス以降だけを使う(添字0は見ない。第1パスは control が正)
    colors: 1,                  // 地色を除く色数 c。2色(c=1)=1パス、3色以上は c+1 パス
    gaugeRatio: 0.75,
  }));
  const docRef = useRef(doc);
  useEffect(() => { docRef.current = doc; }, [doc]);

  /* -------- 編み機へ転送中のロック --------
     転送は MODE_ENTER で目数・段数を宣言してから ROW_DATA を流す方式なので、途中で doc が
     差し替わると機器側と食い違う(段数が減れば sendRow が範囲外を掴んで転送が落ちる)。
     running は KnitControl 内部の状態なので onRunningChange で親へ引き上げ、doc の変更経路
     (commit / undo / redo)をここで一括して塞ぐ。UI 側の disabled は利用者への提示用で、
     実際の防御はこのゲートが担う。 */
  const [knitBusy, setKnitBusy] = useState(false);
  const knitBusyRef = useRef(false);
  const sayRef = useRef(() => {});
  const setKnitRunning = useCallback((v) => { knitBusyRef.current = v; setKnitBusy(v); }, []);
  const busyBlocked = useCallback(() => {
    if (!knitBusyRef.current) return false;
    sayRef.current("編み機へ転送中です。ストップしてからパターンを変更してください");
    return true;
  }, []);

  /* -------- history (undo/redo, 50件) -------- */
  const undoRef = useRef([]); const redoRef = useRef([]);
  const [histVer, setHistVer] = useState(0);
  const snapshot = (d) => ({ stitches: d.stitches, rows: d.rows, palette: d.palette.slice(), grid: cloneGrid(d.grid), control: (d.control || []).slice(), passControl: (d.passControl || []).map((a) => (a ? a.slice() : a)), colors: d.colors, gaugeRatio: d.gaugeRatio });
  const pushUndo = useCallback((d) => {
    undoRef.current.push(snapshot(d));
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
    setHistVer((v) => v + 1);
  }, []);
  /* 1回の編集 = 1履歴(updater内でのsetState回避のため同期refを使用) */
  const commit = useCallback((updater) => {
    if (busyBlocked()) return;
    const prev = docRef.current;
    pushUndo(prev);
    let next = typeof updater === "function" ? updater(snapshot(prev)) : updater;
    /* 図案に色数の外の色番号が入ったら(別の色数の図案からの貼り付けなど)、色数をその番号まで引き上げる。
       書き出しと転送は「使っている最大の色番号」でパス数を決めるので、画面の色数と常にそろえておく。 */
    const m = maxColorNo(next.grid);
    if (m > clamp(next.colors || 1, 1, MAX_COLOR_NO)) {
      next = { ...next, colors: clamp(m, 1, MAX_COLOR_NO) };
      sayRef.current(`図案に色${m}が入ったため、色数を${m + 1}色（${passCount(m)}パス）にしました`);
    }
    docRef.current = next;
    setDoc(next);
  }, [pushUndo, busyBlocked]);
  /* 読み込み・新規のように、編集ではなくパターンを入れ替える commit。入れ替えた直後は「編集なし」とする */
  const commitLoaded = (updater) => { commit(updater); cleanDocRef.current = docRef.current; setPatDirty(false); };
  const undo = useCallback(() => {
    if (busyBlocked()) return;
    if (!undoRef.current.length) return;
    redoRef.current.push(snapshot(docRef.current));
    const p = undoRef.current.pop();
    docRef.current = p;
    setDoc(p);
    setHistVer((v) => v + 1);
    setSelection(null); setGhost(null);
    setSInput(String(p.stitches)); setRInput(String(p.rows));
  }, [busyBlocked]);
  const redo = useCallback(() => {
    if (busyBlocked()) return;
    if (!redoRef.current.length) return;
    undoRef.current.push(snapshot(docRef.current));
    const p = redoRef.current.pop();
    docRef.current = p;
    setDoc(p);
    setHistVer((v) => v + 1);
    setSelection(null); setGhost(null);
    setSInput(String(p.stitches)); setRInput(String(p.rows));
  }, [busyBlocked]);

  /* -------- UI state -------- */
  const [editMode, setEditMode] = useState(false); // false=表示モード(デフォルト), true=編集モード
  const [knitCtrl, setKnitCtrl] = useState(false); // 編み機コントロール(WS転送)のオーバーレイ
  /* 一度つないだ編み機コントローラーの接続先。コントロールを閉じると KnitControl は
     アンマウントされて状態を失うので、記憶はここ(親)に置き、次に開いたとき自動で接続し直す(7.6)。 */
  const [lastConn, setLastConn] = useState(null);   // { url, key, subnet, port }
  /* 空通しの開始側("R" = 右端 / "L" = 左端)。編み機コントロールを閉じても残す(既定は右端) */
  const [calSide, setCalSide] = useState("R");
  const [tool, setTool] = useState("pen"); // pen | fill | line | rect | select
  const [mirror, setMirror] = useState(false);
  const [rectFilled, setRectFilled] = useState(false);
  const [selColor, setSelColor] = useState(1);
  const [cellSize, setCellSize] = useState(22);
  const [selection, setSelection] = useState(null); // {x,y,w,h}
  const [clipboard, setClipboard] = useState(null); // {w,h,cells}
  const [ghost, setGhost] = useState(null); // {x,y,w,h,cells,src?:{x,y,w,h}}
  const [dragShape, setDragShape] = useState(null); // line/rect preview {x0,y0,x1,y1}
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewKnit, setPreviewKnit] = useState(true);
  const [previewRepeat, setPreviewRepeat] = useState(false);
  const [checks, setChecks] = useState({ colors: false, maxColors: 2, float: false, floatLimit: 5 });
  const [sInput, setSInput] = useState("24");
  const [rInput, setRInput] = useState("60");
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  /* commit/undo/redo は say より前で定義されるため、ref 経由で参照する */
  const say = useCallback((msg, ms = 2600) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  sayRef.current = say;
  /* サンドボックスでwindow.confirmが無効な場合に備えた自作確認ダイアログ */
  const [confirmBox, setConfirmBox] = useState(null); // {msg, onOk, okOnly?, okLabel?, altLabel?, onAlt?}
  const ask = (msg, onOk) => setConfirmBox({ msg, onOk });
  /* OKだけの警告ダイアログ(選択肢がない通知に使う) */
  const warn = (msg) => setConfirmBox({ msg, onOk: null, okOnly: true });

  /* palette panel */
  const [palPos, setPalPos] = useState(null); // null = 初期位置(右下)
  const [palMin, setPalMin] = useState(false);
  /* 選択・配置の操作パレット。以前は図案の上に差し込む帯だったが、出入りするたびに図案が
     上下へ動いてドラッグ中の座標がずれたため、絶対配置の浮動パレットにした(3.3)。
     絶対配置なので開閉しても図案の位置は動かない。 */
  const [editBarOpen, setEditBarOpen] = useState(true);
  const [editBarMin, setEditBarMin] = useState(false);
  const [editBarPos, setEditBarPos] = useState(null);   // null = 初期位置
  const colorInputRef = useRef(null);
  const [hexDraft, setHexDraft] = useState(DEFAULT_PALETTE[1]);
  /* パレット下部のカラー変更バーの開閉。既定は閉じてパレットを小さく保ち、
     スウォッチの長押しで開く。見出しの「色」ボタンでも開閉できるので、
     長押しを知らなくても色を変えられる(3.6)。 */
  const [colorBarOpen, setColorBarOpen] = useState(false);
  /* hex入力は選択中の色番号と現在の配色に追従させる(入力中に書き換わることはない) */
  useEffect(() => { setHexDraft(padPalette(doc.palette)[selColor] || "#000000"); }, [selColor, doc.palette]);
  /* preview floating window (デスクトップ用) */
  const [pvOpen, setPvOpen] = useState(true);
  const [pvMin, setPvMin] = useState(false);
  const [pvBox, setPvBox] = useState({ x: 12, y: 12, w: 280, h: 340 });
  const [swatchMenu, setSwatchMenu] = useState(null); // {index,x,y,mode}
  const [gridMenu, setGridMenu] = useState(null); // {col,row,x,y} グリッド上の右クリックメニュー
  /* SR形式パターン集(メモリ内保持) */
  const [library, setLibrary] = useState([]); // entry = { s, r, grid, palette, colors, control, passControl }
  /* ブラウザのタブ名にも版を出す(HTML の <title> もビルド時に同じ文字列にしている) */
  useEffect(() => { try { document.title = `SRパタコン ${APP_REV}`; } catch (_) { /* document の無い環境 */ } }, []);
  /* パターン集への登録・保存を促す印。
     ・patDirty: 今のパターンが、読み込んだ・新規にした・パターン集へ追加した時点から編集されている。
       その時点の doc を cleanDocRef に覚え、doc が別のものになったら編集ありとする(元に戻すで戻した場合も編集ありのまま)。
       図案に何か描かれていて、パターン集に空きがあれば「パターン集に追加」ボタンに色を付ける。
     ・libDirty: パターン集が、パターン集ファイルを保存・読み込み(置き換え)した時点から変わっている
       (追加・取り込み・削除)。「パターン集を保存」ボタンに色を付ける。パターン集が空になったら消す。 */
  const cleanDocRef = useRef(null);
  const [patDirty, setPatDirty] = useState(false);
  const [libDirty, setLibDirty] = useState(false);
  const markDocClean = () => { cleanDocRef.current = docRef.current; setPatDirty(false); };
  useEffect(() => {
    if (cleanDocRef.current === null) cleanDocRef.current = doc;   // 起動時のパターンは編集なし
    setPatDirty(doc !== cleanDocRef.current);
  }, [doc]);
  useEffect(() => { if (!library.length) setLibDirty(false); }, [library.length]);
  /* パターン集に結びついたファイル名。パターン集ファイルを読み込むと入り、保存するとその名前になる。
     パターン集の上部に表示し、保存ダイアログの候補名に使う。パターン集が空になったら消す。 */
  const [libName, setLibName] = useState("");
  /* パターン集に結びついたメモ。ファイル名と同じ扱いで、読み込むと入り、保存するとその内容になる。 */
  const [libMemo, setLibMemo] = useState("");
  useEffect(() => { if (!library.length) { setLibName(""); setLibMemo(""); } }, [library.length]);
  const [saveBox, setSaveBox] = useState(null);   // 保存名ダイアログ { name, error }
  const saveNameRef = useRef(null);
  /* パターン集ピッカー(フローティングウィンドウ) */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBox, setPickerBox] = useState({ x: 40, y: 60, w: 340, h: 400 });
  const [pickerNew, setPickerNew] = useState(null); // 直前の読み込みで追加した範囲 {from,to}(indexは含む/含まない)。ハイライト用
  useEffect(() => { if (!pickerOpen) setPickerNew(null); }, [pickerOpen]); // 閉じたら新規ハイライトを解除
  /* 選択やゴーストが現れたら操作パレットを開く。有無が変わった瞬間だけ働くので、
     選択したまま閉じたパレットが勝手に開き直すことはない。 */
  useEffect(() => { if (selection || ghost) setEditBarOpen(true); }, [!!selection, !!ghost]);
  const fileInputRef = useRef(null);
  const txtInputRef = useRef(null);
  const binInputRef = useRef(null); // U-BOXバイナリ読込用のfile入力
  const datInputRef = useRef(null); // PC10 .DAT 読込用のfile入力(複数選択可)
  const libInputRef = useRef(null); // パターン集ファイル(全データ・JSON)読込用のfile入力

  /* responsive */
  const [isNarrow, setIsNarrow] = useState(false);
  const [mobileTab, setMobileTab] = useState("edit");
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setIsNarrow(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const gridCanvasRef = useRef(null);
  const scrollRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const previewWrapRef = useRef(null);
  /* 固定表示(フリーズ)ペイン: 左=段数インデックス+制御マス+制御記号 / 上=目数インデックス+凡例 */
  const leftPaneRef = useRef(null);
  const topPaneRef = useRef(null);
  const cornerPaneRef = useRef(null);
  const dprRef = useRef(1);
  const frozenRafRef = useRef(0);
  const paintFrozenRef = useRef(() => {});

  /* 描く色は選択中の色番号そのもの。消すときは地色(色0)スロットを選ぶ。 */
  const drawColor = selColor;
  /* 選択中の色番号は色数の範囲に収める。色数が下がる経路は色数の変更だけでなく、パターン読込・JSON読込・undo/redo
     もあるので doc.colors に追従させる(範囲外の色のまま描くと、画面の色数のまま黙ってパス数が増えていた)。 */
  useEffect(() => {
    const n = clamp(doc.colors || 1, 1, MAX_COLOR_NO);
    if (selColor > n) setSelColor(n);
  }, [doc.colors, selColor]);
  const S = doc.stitches, R = doc.rows;
  const maxCell = Math.min(44, Math.max(6, Math.floor(3800 / Math.max(S, R))));
  const cell = Math.min(cellSize, maxCell);

  /* ============================== 検証 ============================== */
  const warns = useMemo(() => {
    const colorRows = new Set(), floatRows = new Set();
    if (!checks.colors && !checks.float) return { colorRows, floatRows };
    for (let r = 0; r < R; r++) {
      const row = doc.grid[r];
      if (checks.colors) {
        const set = new Set(row);
        if (set.size > checks.maxColors) colorRows.add(r);
      }
      if (checks.float) {
        const last = new Map();
        for (let c = 0; c < S; c++) {
          const v = row[c];
          if (last.has(v) && c - last.get(v) - 1 > checks.floatLimit) floatRows.add(r);
          last.set(v, c);
        }
      }
    }
    return { colorRows, floatRows };
  }, [doc.grid, checks, S, R]);
  const warnCount = warns.colorRows.size + warns.floatRows.size;

  /* ============================== グリッド描画 ============================== */
  /* 左側に [段番号ガター][制御ビット4列][空け1列] を確保。M.left はパターンの原点。 */
  const IDXW = 26;                          // 段番号ガター幅(px)
  const CTRLN = 4, CTRLGAP = 1;             // 制御ビット列数 / パターンとの空け列(横)
  /* 制御マスを何本の帯に割るか = パス数。設定した色数、図案で使っている色数、
     読み込みで保持した各パスの制御4bitの本数、のうち最大を採る。 */
  const ctrlPassN = useMemo(() => {
    let m = 0;
    for (const row of doc.grid) for (const v of row) if (v > m) m = v;
    const held = (doc.passControl || []).reduce((a, x) => Math.max(a, x ? x.length : 0), 0);
    const c = clamp(Math.max(m, doc.colors || 0), 1, MAX_COLOR_NO);
    return clamp(Math.max(passCount(c), held), 1, MAX_PASS);
  }, [doc.grid, doc.passControl, doc.colors]);

  /* 編集モードで制御ビット(ブザー・指示ビット)を表示・編集するパス。
     ・2色(1パス)は色1パスだけなので固定(ドロップリストは無効)。
     ・多色(n色 = nパス)は色1パス〜色(n−1)パスから選ぶ。最終の色nパスは地色(色0)を編むパスで、
       地色と同じ図案になるため選択肢に出さない(編集しない)。
     色1パスはデザイン段の制御(doc.control)そのもの、色2パス以降はパス固有(doc.passControl)。
     非編集モードは選択に関係なく、全パスの制御ビットを横帯に分けて並べて表示する。
     以前は既定が「制御ビット表示モード」(編集しない)で、そのまま制御マスを押しても何も変わらなかった。 */
  const [ctrlTarget, setCtrlTarget] = useState(1);
  const ctrlMaxPass = ctrlPassN < 2 ? 1 : ctrlPassN - 1;   // 選べるパスの上限
  const ctrlSel = clamp(ctrlTarget, 1, ctrlMaxPass);        // 実際に表示・編集するパス
  useEffect(() => { if (ctrlTarget !== ctrlSel) setCtrlTarget(ctrlSel); }, [ctrlTarget, ctrlSel]);

  const TOPLBL = 30, TOPGAP = 1;            // 上部ラベル帯の高さ(px) / 目数インデックスとパターンの空け行(縦・左のCTRLGAPと対応)
  const ctrlW = (CTRLN + CTRLGAP) * cell;   // 制御領域(空け列含む)の幅
  const M = { left: IDXW + ctrlW, top: TOPLBL + TOPGAP * cell, right: 8, bottom: 22 }; // top=ラベル帯+空け行
  const PAD = 12;                           // スクロール領域の内側余白(固定ペインの位置合わせに使用)
  const PANE_BG = "#20242c";                // スクロール領域の背景(固定ペインの下敷き)
  /* 貼り付け(ゴースト)の配置余白。ゴーストを置いているあいだは、図案の上と右に「広げて貼れる範囲」を
     キャンバスへ足し、目数・段数の外へはみ出した部分も見えるようにする(確定時に広げて貼れる。confirmGhost)。
     広げるのは最上段の上と右端の右だけ(既存の段番号・目番号が動かない側)で、左端・最下段の外は従来どおり切り捨て。
     余白の大きさはゴーストの段数・目数ぶん(MAX_R / MAX_S を超えない)で、置いているあいだは縮めない。
     ドラッグ中に縮めると、上の余白が減ったぶん図案が画面上で動き、指の下のマスがずれてゴーストが走ってしまうため。
     上の余白は図案全体を ghostOY だけ下げて描く。当たり判定(toLocal)と固定ペインはこの量を差し引く。
     余白はゴーストをドラッグしている最中には広げない(選択範囲をつかんで移動するときは、つかんだ瞬間に
     ゴーストができる。そこで余白が増えると指の下のマスがずれるため)。指を離した時点で広げる。 */
  const ghostResRef = useRef({ top: 0, right: 0 });
  const ghostDragRef = useRef(false);        // ゴーストをドラッグ中(余白を広げない)
  const ghostRes = !ghost ? { top: 0, right: 0 }
    : ghostDragRef.current ? ghostResRef.current
    : { top: Math.max(ghostResRef.current.top, Math.min(ghost.h, MAX_R - R)), right: Math.max(ghostResRef.current.right, Math.min(ghost.w, MAX_S - S)) };
  ghostResRef.current = ghostRes;
  const ghostOY = ghostRes.top * cell;
  const ghostResDrawnRef = useRef(0);        // 前回描いたときの上の余白(段)。変わったぶんスクロールを補正する
  const revealGhostRef = useRef(false);      // 次の描画でゴーストが見える位置までスクロールする(パターン集からのコピー)
  /* ゴーストの位置を置ける範囲に収める。上は余白の段数まで、右は余白の目数まで(=広げられる上限)、
     左と下は少なくとも1目・1段が図案にかかるところまで。 */
  const fitGhost = (g) => {
    const grow = !ghostDragRef.current;
    const rt = grow ? Math.max(ghostResRef.current.top, Math.min(g.h, MAX_R - R)) : ghostResRef.current.top;
    const rr = grow ? Math.max(ghostResRef.current.right, Math.min(g.w, MAX_S - S)) : ghostResRef.current.right;
    return { ...g, x: clamp(g.x, -(g.w - 1), Math.max(-(g.w - 1), S + rr - g.w)), y: clamp(g.y, -rt, R - 1) };
  };
  /* 本体キャンバスがスクロール内容の中で PAD の位置からどれだけずれているか。編集モードでは制御層のドロップリストが
     キャンバスの上に入り、その高さぶん下がる。固定ペインの転写位置と当たり判定の読み替えはこの量で補正する。
     (offset を持たない環境では 0) */
  const canvasShift = (cv) => ({ ex: Math.max(0, (cv.offsetLeft || 0) - PAD), ey: Math.max(0, (cv.offsetTop || 0) - PAD) });
  useEffect(() => {
    const cv = gridCanvasRef.current;
    if (!cv) return;
    const cssW = M.left + (S + ghostRes.right) * cell + M.right;
    const cssH = ghostOY + M.top + R * cell + M.bottom;
    const dpr = Math.min(window.devicePixelRatio || 1, 4096 / Math.max(cssW, cssH), 2);
    dprRef.current = dpr;                    // 固定ペインが同じ倍率で転写できるように保持
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + "px"; cv.style.height = cssH + "px";
    /* 上の配置余白が増減したら、そのぶんスクロールをずらして図案を画面上の同じ位置に保つ */
    const sc0 = scrollRef.current;
    if (sc0 && ghostResDrawnRef.current !== ghostRes.top) sc0.scrollTop += (ghostRes.top - ghostResDrawnRef.current) * cell;
    ghostResDrawnRef.current = ghostRes.top;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#e8e4da";
    ctx.fillRect(0, 0, cssW, cssH);
    /* 以降は図案の座標で描く(上の配置余白ぶん下げる。余白が無ければ従来と同じ) */
    ctx.setTransform(dpr, 0, 0, dpr, 0, ghostOY * dpr);
    /* 配置余白(広げて貼れる範囲)。淡い青で塗り、マスの目安の線を引く */
    if (ghost && (ghostRes.top || ghostRes.right)) {
      ctx.save();
      const zx0 = M.left, zx1 = M.left + (S + ghostRes.right) * cell;
      const zy0 = M.top - ghostRes.top * cell, zy1 = M.top + R * cell;
      ctx.fillStyle = "rgba(56,189,248,0.13)";
      if (ghostRes.top) ctx.fillRect(zx0, zy0, zx1 - zx0, M.top - zy0);
      if (ghostRes.right) ctx.fillRect(M.left + S * cell, M.top, ghostRes.right * cell, R * cell);
      ctx.strokeStyle = "rgba(40,110,150,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c <= S + ghostRes.right; c++) {
        const x = M.left + c * cell + 0.5;
        if (ghostRes.top) { ctx.moveTo(x, zy0); ctx.lineTo(x, M.top); }
        if (c >= S) { ctx.moveTo(x, M.top); ctx.lineTo(x, zy1); }
      }
      for (let r = -ghostRes.top; r <= R; r++) {
        const y = M.top + r * cell + 0.5;
        if (r <= 0) { ctx.moveTo(zx0, y); ctx.lineTo(zx1, y); }
        else if (ghostRes.right) { ctx.moveTo(M.left + S * cell, y); ctx.lineTo(zx1, y); }
      }
      ctx.stroke();
      ctx.restore();
    }
    /* cells */
    const pal = padPalette(doc.palette);
    for (let r = 0; r < R; r++) {
      const row = doc.grid[r];
      for (let c = 0; c < S; c++) {
        ctx.fillStyle = pal[row[c]] || "#f00";
        ctx.fillRect(M.left + c * cell, M.top + r * cell, cell + 0.5, cell + 0.5);
      }
    }
    /* move元の表示(ghost.src は地色で表示) */
    if (ghost && ghost.src) {
      ctx.fillStyle = doc.palette[0];
      ctx.fillRect(M.left + ghost.src.x * cell, M.top + ghost.src.y * cell, ghost.src.w * cell, ghost.src.h * cell);
    }
    /* line/rect プレビュー */
    if (dragShape) {
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = doc.palette[drawColor];
      const put = (x, y) => { if (x >= 0 && x < S && y >= 0 && y < R) ctx.fillRect(M.left + x * cell, M.top + y * cell, cell, cell); };
      if (dragShape.kind === "line") bresenham(dragShape.x0, dragShape.y0, dragShape.x1, dragShape.y1, put);
      else {
        const x0 = Math.min(dragShape.x0, dragShape.x1), x1 = Math.max(dragShape.x0, dragShape.x1);
        const y0 = Math.min(dragShape.y0, dragShape.y1), y1 = Math.max(dragShape.y0, dragShape.y1);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
          if (rectFilled || y === y0 || y === y1 || x === x0 || x === x1) put(x, y);
      }
      ctx.globalAlpha = 1;
    }
    /* grid lines (5目/5段ごとに太線、番号は下→上・右→左) */
    ctx.strokeStyle = "rgba(60,64,72,0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= S; c++) { const x = M.left + c * cell + 0.5; ctx.moveTo(x, M.top); ctx.lineTo(x, M.top + R * cell); }
    for (let r = 0; r <= R; r++) { const y = M.top + r * cell + 0.5; ctx.moveTo(M.left, y); ctx.lineTo(M.left + S * cell, y); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(45,48,55,0.6)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let c = 0; c <= S; c++) if (c % 5 === 0) { const x = M.left + c * cell + 0.5; ctx.moveTo(x, M.top); ctx.lineTo(x, M.top + R * cell); }
    for (let r = 0; r <= R; r++) if ((R - r) % 5 === 0) { const y = M.top + r * cell + 0.5; ctx.moveTo(M.left, y); ctx.lineTo(M.left + S * cell, y); }
    ctx.stroke();
    /* 編集モードでは各マスの右下に色番号(=そのマスを編むパス)を出す。
       パレットのスウォッチ右下と同じ見せ方にそろえる。地色(0)のマスにも 0 を入れる。
       マスが小さいと数字が潰れて格子が読めなくなるので、一定の大きさから上でだけ描く。 */
    if (editMode && cell >= 10) {
      const fs = Math.max(7, Math.min(11, Math.round(cell * 0.42)));
      ctx.save();
      ctx.font = `${fs}px sans-serif`;
      ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      /* 地色は面積が広く数字が並ぶので、色付きのマスより薄く置いて図案の邪魔をしないようにする */
      const ink = pal.map((hex, i) => (luminance(hex) > 0.6
        ? (i ? "rgba(0,0,0,.55)" : "rgba(0,0,0,.3)")
        : (i ? "rgba(255,255,255,.72)" : "rgba(255,255,255,.4)")));
      for (let r = 0; r < R; r++) {
        const row = doc.grid[r];
        for (let c = 0; c < S; c++) {
          const v = row[c];
          ctx.fillStyle = ink[v] || "rgba(0,0,0,.55)";
          ctx.fillText(String(v), M.left + (c + 1) * cell - 1.5, M.top + (r + 1) * cell - 1);
        }
      }
      ctx.restore();
    }
    /* ミラー描画の対称軸ガイド */
    if (mirror) {
      ctx.save();
      ctx.strokeStyle = "rgba(56,189,248,0.85)";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      const mx = M.left + (S / 2) * cell + 0.5;
      ctx.beginPath(); ctx.moveTo(mx, M.top); ctx.lineTo(mx, M.top + R * cell); ctx.stroke();
      ctx.restore();
    }
    /* 番号 + 警告 */
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let r = 0; r < R; r++) {
      const num = R - r;                                  // 最下段=1段目
      const warn = warns.colorRows.has(r) || warns.floatRows.has(r);
      if (warn) {
        ctx.fillStyle = "rgba(225,72,72,0.85)";
        ctx.fillRect(0, M.top + r * cell, 4, cell);
      }
      if (num === 1 || num % 5 === 0 || warn) {
        ctx.fillStyle = warn ? "#c22" : "#555a63";
        ctx.fillText(String(num), IDXW - 5, M.top + r * cell + cell / 2);
      }
    }
    ctx.fillStyle = "#555a63";
    /* 上部の目数番号(下部と同じ番号)。ラベル帯に置き、パターンとの間に空け行(TOPGAP)をあける */
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    for (let c = 0; c < S; c++) {
      const num = c + 1;                                  // 左端=1目
      if (num === 1 || num % 5 === 0) ctx.fillText(String(num), M.left + c * cell + cell / 2, TOPLBL - 4);
    }
    /* 下部の目数番号 */
    ctx.textBaseline = "top";
    for (let c = 0; c < S; c++) {
      const num = c + 1;                                  // 左端=1目
      if (num === 1 || num % 5 === 0) ctx.fillText(String(num), M.left + c * cell + cell / 2, M.top + R * cell + 5);
    }
    /* ===== 制御ビット(段ごと4bit)のマス目 + 凡例 =====
       左からブザー / 指示記号a / b / c の4マス。パターンとの間は空け列。 */
    {
      const CTRL = doc.control || [];
      const cx0 = IDXW; // 制御領域の左端
      /* 凡例(上部): 各制御マスの枠に合わせて2段で表示する。
           上段  :  <  　 >     (a単独=<, c単独=>)
           下段  : B { ＊ }     (Bはブザー列 / a+b={, b単独=＊, b+c=}) */
      ctx.save();
      const lf = Math.max(6, Math.min(9, Math.round(cell * 0.5))); // マス幅に合わせた凡例の文字サイズ
      ctx.font = `${lf}px sans-serif`;
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "center";
      /* 指示記号の文字は CTRL_SYM と揃える(1=> / 2=＊ / 3=} / 4=< / 6={)。
         上段は単独ビット、下段は隣接ビットの組み合わせに対応する。 */
      const legTop = ["", CTRL_SYM[4], "", CTRL_SYM[1]];   // k=0:ブザー 1:a 2:b 3:c
      const legBot = ["B", CTRL_SYM[6], CTRL_SYM[2], CTRL_SYM[3]];
      for (let k = 0; k < CTRLN; k++) {
        const lx = cx0 + (k + 0.5) * cell;      // その制御マスの中央に揃える
        if (legTop[k]) ctx.fillText(legTop[k], lx, TOPLBL - 3 - (lf + 3));
        if (legBot[k]) ctx.fillText(legBot[k], lx, TOPLBL - 3);
      }
      ctx.restore();
      /* 各段のマス目。
         多色(Nパス)のときは1マスをパス数ぶんの横帯に割り、そのパスの色で塗る。上端の帯が第1パス。
         デザイン段の制御4bit(= 第1パスの制御)に加えて、第2パス以降に固有の制御があればそれも見える。
         ブザーだけは色ではなく機器の動作なので、どのパスでも琥珀で塗り、位置(帯)でどのパスかを示す。 */
      const PC = doc.passControl || [];
      const passN = ctrlPassN;
      /* マークの色はそのパスの色。淡すぎて地(#f4f2ea)に埋もれる色のときだけ暗色へ落とす。 */
      const markColor = (pno) => {
        const c = doc.palette[passColorNo(pno, passN)] || "#3a3f47";
        return luminance(c) > 0.88 ? "#3a3f47" : c;
      };
      const passCtrl = (r, pno) => passControlOf(CTRL, PC, r, pno, passN, true);   // 表示(a を外した印を反映)
      /* 表示する層。編集モードではドロップリストで選んだパス(2色は色1パス)だけを1マスいっぱいに描く。
         非編集モードは、マスをパス数ぶんの横帯に分割して全パスの制御ビットを並べる(上端の帯が第1パス)。 */
      const only = !editMode ? 0 : ctrlSel;
      for (let r = 0; r < R; r++) {
        for (let k = 0; k < CTRLN; k++) {
          const x = cx0 + k * cell, y = M.top + r * cell;
          ctx.fillStyle = "#f4f2ea";                    // マスの地
          ctx.fillRect(x, y, cell, cell);
          const bit = 8 >> k;                            // k=0:ブザー(bit3) 1:a 2:b 3:c
          if (only) {
            if (passCtrl(r, only) & bit) {
              ctx.fillStyle = k === 0 ? BUZZ_COLOR : markColor(only); // ブザーは機器動作なので常に橙
              ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
            }
          } else {
            const bh = (cell - 2) / passN;
            for (let q = 1; q <= passN; q++) {
              if (!(passCtrl(r, q) & bit)) continue;
              ctx.fillStyle = k === 0 ? BUZZ_COLOR : markColor(q);
              ctx.fillRect(x + 1, y + 1 + (q - 1) * bh, cell - 2, bh);
              if (passN > 1) {                           // 帯の切れ目が分かるように縁取る
                ctx.strokeStyle = "rgba(60,64,72,0.45)"; ctx.lineWidth = 0.5;
                ctx.strokeRect(x + 1.25, y + 1.25 + (q - 1) * bh, cell - 2.5, bh - 0.5);
              }
            }
          }
          ctx.strokeStyle = "rgba(60,64,72,0.5)";
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        }
        /* 指示記号を「制御マスとパターンの間の空け列」に表示する。色を選んでいればその層の記号、
           表示モードでは記号を持つ最も小さいパス番号の制御ビットに従う。色は同じくそのパスの色。 */
        let symPass = only;
        if (!symPass) { for (let q = 1; q <= passN; q++) if (ctrlSymbol(passCtrl(r, q))) { symPass = q; break; } }
        const sym = symPass ? ctrlSymbol(passCtrl(r, symPass)) : "";
        if (sym) {
          ctx.save();
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.font = `${Math.max(10, Math.min(cell - 2, 18))}px sans-serif`;
          ctx.fillStyle = markColor(symPass);
          ctx.fillText(sym, M.left - cell / 2, M.top + r * cell + cell / 2); // 空け列の中央
          ctx.restore();
        }
      }
    }
    /* ===== 目数・段数インデックスのマス目(タップで選択 / 長押しで挿入・削除) ===== */
    {
      ctx.save();
      for (let r = 0; r < R; r++) {                       // 段インデックス(左ガター)
        const y = M.top + r * cell;
        const sel = selection && selection.x === 0 && selection.w === S && r >= selection.y && r < selection.y + selection.h;
        ctx.strokeStyle = sel ? "#f5a623" : "rgba(70,76,86,0.45)";
        ctx.lineWidth = sel ? 2 : 1;
        ctx.strokeRect(0.5, y + 0.5, IDXW - 1, cell - 1);
      }
      for (let c = 0; c < S; c++) {                       // 目インデックス(上・下)
        const x = M.left + c * cell;
        const sel = selection && selection.y === 0 && selection.h === R && c >= selection.x && c < selection.x + selection.w;
        ctx.strokeStyle = sel ? "#f5a623" : "rgba(70,76,86,0.45)";
        ctx.lineWidth = sel ? 2 : 1;
        ctx.strokeRect(x + 0.5, 0.5, cell - 1, M.top - 1);
        ctx.strokeRect(x + 0.5, M.top + R * cell + 0.5, cell - 1, M.bottom - 1);
      }
      ctx.restore();
    }
    /* selection */
    if (selection) {
      ctx.save();
      ctx.strokeStyle = "#f5a623";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.fillStyle = "rgba(245,166,35,0.12)";
      const sx = M.left + selection.x * cell, sy = M.top + selection.y * cell;
      ctx.fillRect(sx, sy, selection.w * cell, selection.h * cell);
      ctx.strokeRect(sx + 1, sy + 1, selection.w * cell - 2, selection.h * cell - 2);
      ctx.restore();
    }
    /* ghost */
    if (ghost) {
      ctx.save();
      ctx.globalAlpha = 0.68;
      /* 図案の外でも、配置余白(上・右)にかかる部分は描く。左端・最下段の外は貼らないので描かない */
      for (let r = 0; r < ghost.h; r++) for (let c = 0; c < ghost.w; c++) {
        const gx = ghost.x + c, gy = ghost.y + r;
        if (gx < 0 || gx >= S + ghostRes.right || gy < -ghostRes.top || gy >= R) continue;
        ctx.fillStyle = doc.palette[ghost.cells[r][c]] || "#f00";
        ctx.fillRect(M.left + gx * cell, M.top + gy * cell, cell, cell);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(M.left + ghost.x * cell + 1, M.top + ghost.y * cell + 1, ghost.w * cell - 2, ghost.h * cell - 2);
      ctx.restore();
    }
    /* パターン集からコピーした直後は、ゴーストが見える位置までスクロールする(はみ出して置いたときに画面外にならないように) */
    if (ghost && revealGhostRef.current && sc0) {
      revealGhostRef.current = false;
      const gTop = cv.offsetTop + ghostOY + M.top + ghost.y * cell, gBot = gTop + ghost.h * cell;
      const gLeft = cv.offsetLeft + M.left + ghost.x * cell, gRight = gLeft + ghost.w * cell;
      if (gTop < sc0.scrollTop || gBot > sc0.scrollTop + sc0.clientHeight) sc0.scrollTop = Math.max(0, gTop - M.top - 8);
      if (gLeft < sc0.scrollLeft + M.left || gRight > sc0.scrollLeft + sc0.clientWidth) sc0.scrollLeft = Math.max(0, gLeft - M.left - PAD - 8);
    }
  }, [doc, cell, selection, ghost, ghostRes.top, ghostRes.right, dragShape, warns, drawColor, rectFilled, S, R, mirror, isNarrow, mobileTab, editMode, ctrlSel, ctrlPassN]);

  /* ============================== 固定表示(左列・上端)============================== */
  /* スクロールしても
       ・左端 = 段数インデックス + 制御マス4列 + 制御記号の空け列 (幅 M.left)
       ・上端 = 目数インデックス + 制御ビット凡例                (高さ M.top)
     が常に見えるようにする。本体キャンバスの該当領域をそのまま転写しているので
     描画コードは二重化されず、見た目・配色・選択ハイライトも完全に一致する。
     ペインは pointer-events:none。当たり判定側(toLocal)で座標を読み替える。 */
  const paintFrozen = useCallback(() => {
    const cv = gridCanvasRef.current, sc = scrollRef.current;
    if (!cv || !sc || !cv.width) return;
    const dpr = dprRef.current;
    const sl = sc.scrollLeft, st = sc.scrollTop;
    const vw = sc.clientWidth, vh = sc.clientHeight;
    const cssW = cv.width / dpr, cssH = cv.height / dpr;   // 本体キャンバスのCSSサイズ
    const lw = PAD + M.left, th = PAD + M.top;             // 固定ペインの幅 / 高さ(内側余白を含む)
    const { ex, ey } = canvasShift(cv);
    const ox = PAD + ex, oy = PAD + ey;                    // スクロール内容の中でのキャンバス原点
    const prep = (el, w, h) => {
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (el.width !== pw) el.width = pw;
      if (el.height !== ph) el.height = ph;
      el.style.width = w + "px"; el.style.height = h + "px";
      el.style.display = "block";
      const c = el.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = PANE_BG;                               // スクロールした図案が透けないよう下敷きを塗る
      c.fillRect(0, 0, w, h);
      return c;
    };
    /* 左の固定列: 縦スクロールだけ追従(段と行がずれないよう、キャンバスの実際の位置 oy-st に置く) */
    const lp = leftPaneRef.current;
    if (lp) {
      if (sl > ex) {
        const c = prep(lp, lw, vh);
        const above = Math.max(0, oy - st);                // キャンバス上端より上(ドロップリストの行)は透かす
        if (above > 0) c.clearRect(0, 0, lw, above);
        const y0 = clamp(st - oy, 0, cssH), y1 = clamp(st - oy + vh, 0, cssH);
        if (y1 > y0) c.drawImage(cv, 0, y0 * dpr, M.left * dpr, (y1 - y0) * dpr, PAD, oy - st + y0, M.left, y1 - y0);
      } else lp.style.display = "none";
    }
    /* 上の固定行: 横スクロールだけ追従。キャンバスのラベル帯が PAD より上へ隠れてから出す */
    /* ゴーストの配置余白があるときは、ラベル帯がキャンバスの ghostOY から始まる */
    const tp = topPaneRef.current;
    if (tp) {
      if (st > ey + ghostOY) {
        const c = prep(tp, vw, th);
        const x0 = clamp(sl - ox, 0, cssW), x1 = clamp(sl - ox + vw, 0, cssW);
        if (x1 > x0) c.drawImage(cv, x0 * dpr, ghostOY * dpr, (x1 - x0) * dpr, M.top * dpr, ox - sl + x0, PAD, x1 - x0, M.top);
      } else tp.style.display = "none";
    }
    /* 左上の角(凡例部分): 縦横とも動いているときだけ必要 */
    const cp = cornerPaneRef.current;
    if (cp) {
      if (sl > ex && st > ey + ghostOY) {
        const c = prep(cp, lw, th);
        c.drawImage(cv, 0, ghostOY * dpr, M.left * dpr, M.top * dpr, PAD, PAD, M.left, M.top);
      } else cp.style.display = "none";
    }
  }, [M.left, M.top, ghostOY]);

  /* 本体キャンバスを描き直した直後(=毎レンダー後)に固定ペインも追従させる */
  useEffect(() => { paintFrozenRef.current = paintFrozen; paintFrozen(); });

  /* スクロール / 表示領域のリサイズに追従(rAFで間引き) */
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const req = () => {
      if (frozenRafRef.current) return;
      frozenRafRef.current = requestAnimationFrame(() => {
        frozenRafRef.current = 0;
        paintFrozenRef.current();
      });
    };
    sc.addEventListener("scroll", req, { passive: true });
    const ro = new ResizeObserver(req);
    ro.observe(sc);
    req();
    return () => {
      sc.removeEventListener("scroll", req);
      ro.disconnect();
      if (frozenRafRef.current) cancelAnimationFrame(frozenRafRef.current);
      frozenRafRef.current = 0;
    };
  }, [isNarrow, mobileTab]);

  /* ============================== プレビュー描画 ============================== */
  const [pvSize, setPvSize] = useState({ w: 300, h: 300 });
  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const b = es[0].contentRect;
      setPvSize({ w: Math.max(50, b.width - 16), h: Math.max(50, b.height - 16) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isNarrow, mobileTab, pvOpen, pvMin]);

  useEffect(() => {
    const cv = previewCanvasRef.current;
    if (!cv) return;
    const tiles = previewRepeat ? 3 : 1;
    const ratio = previewKnit ? doc.gaugeRatio : 1;
    let cw = Math.min(pvSize.w / (S * tiles), pvSize.h / (R * tiles * ratio));
    cw = Math.max(0.4, cw);
    const ch = cw * ratio;
    const cssW = S * tiles * cw, cssH = R * tiles * ch;
    const dpr = Math.min(window.devicePixelRatio || 1, 4096 / Math.max(cssW, cssH), 2);
    cv.width = Math.max(1, Math.round(cssW * dpr));
    cv.height = Math.max(1, Math.round(cssH * dpr));
    cv.style.width = cssW + "px"; cv.style.height = cssH + "px";
    const ctx = cv.getContext("2d");
    /* パターンを1枚オフスクリーンに描いてからタイル */
    const pcw = Math.max(1, cw * dpr), pch = Math.max(1, ch * dpr);
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.round(S * pcw));
    off.height = Math.max(1, Math.round(R * pch));
    const octx = off.getContext("2d");
    const knit = previewKnit && pcw >= 3.2;
    for (let r = 0; r < R; r++) {
      const row = doc.grid[r];
      for (let c = 0; c < S; c++) {
        const hex = doc.palette[row[c]] || "#f00";
        if (knit) drawKnitCell(octx, c * pcw, r * pch, pcw, pch, hex);
        else { octx.fillStyle = hex; octx.fillRect(c * pcw, r * pch, pcw + 0.6, pch + 0.6); }
      }
    }
    ctx.imageSmoothingEnabled = pcw < 2;
    for (let ty = 0; ty < tiles; ty++)
      for (let tx = 0; tx < tiles; tx++)
        ctx.drawImage(off, (tx * cv.width) / tiles, (ty * cv.height) / tiles, cv.width / tiles, cv.height / tiles);
  }, [doc, previewKnit, previewRepeat, pvSize, S, R, isNarrow, mobileTab, pvOpen, pvMin]);

  /* ============================== ポインタ操作 ============================== */
  const pointersRef = useRef(new Map());
  const gestureRef = useRef(null); // {mode, ...}
  const strokeGridRef = useRef(null);
  const lastCellRef = useRef(null);

  /* クライアント座標 → 本体キャンバス内の座標。
     固定ペインの上を指しているときは、ペインが実際に描いている
     (そのぶんスクロールしていない)座標に読み替える。 */
  /* raw=true は固定ペインの読み替えをしない(ゴーストのドラッグ用。ペインの境目でゴーストが跳ばないように)。
     y はゴーストの配置余白(ghostOY)を差し引いた図案の座標で返す。 */
  const toLocal = useCallback((e, raw) => {
    const cv = gridCanvasRef.current, sc = scrollRef.current;
    const rect = cv.getBoundingClientRect();
    const yc = e.clientY - rect.top;                       // キャンバス上の座標(配置余白を含む)
    let x = e.clientX - rect.left, y = yc - ghostOY;
    if (sc && !raw) {
      /* 固定ペインは PAD の位置に貼り付いている。キャンバスが PAD からずれている量(ex, ey)を足してペイン内の座標にする */
      const { ex, ey } = canvasShift(cv);
      const sl = sc.scrollLeft, st = sc.scrollTop;
      const vx = x + ex - sl, vy = yc + ey - st;           // 固定ペイン内での座標
      if (sl > ex && vx < M.left) x = vx < 0 ? -1e6 : vx;  // 余白部分(vx<0)は当たり判定なし
      if (st > ey + ghostOY && vy < M.top) y = vy < 0 ? -1e6 : vy;
    }
    return { x, y };
  }, [M.left, M.top, ghostOY]);

  const toCell = useCallback((e, raw) => {
    const p = toLocal(e, raw);
    const x = Math.floor((p.x - M.left) / cell);
    const y = Math.floor((p.y - M.top) / cell);
    return { x, y, inX: x >= 0 && x < S, inY: y >= 0 && y < R };
  }, [toLocal, cell, S, R, M.left, M.top]);

  /* 制御ビットのマス目クリック判定(左の4列)。col:0=ブザー,1..3=指示ビット */
  const toControlCell = useCallback((e) => {
    const p = toLocal(e);
    const col = Math.floor((p.x - IDXW) / cell);
    const row = Math.floor((p.y - M.top) / cell);
    return { col, row, hit: col >= 0 && col < CTRLN && row >= 0 && row < R };
  }, [toLocal, cell, R, M.top]);
  /* 段rowの制御ビット(col列)をトグル。col0=nibble bit3(ブザー)…col3=bit0。
     ドロップリストで選んだ層(地色 or 各パス)のビットだけを操作する。 */
  const toggleControlBit = useCallback((row, col, target, passN) => {
    if (target < 0) return;                       // 表示モードでは編集しない
    const bit = 3 - col;
    commit((d) => {
      if (target === 1) {                          // 色1 = デザイン段の制御(=第1パスの制御)
        const c = (d.control || []).slice();
        while (c.length < d.rows) c.push(0);
        const v = c[row] || 0;
        if (passN >= 2 && (1 << bit) === passMark(1)) {
          /* 多色の色1パスの aビット(<)は既定で出している。外すときは CTRL_A_OFF の印を立てて bit2 を下ろし、
             付け直すときは印を消して bit2 を上げる(下位4bitは常に実際に出す値と同じにする) */
          c[row] = (v & CTRL_A_OFF) ? ((v & ~CTRL_A_OFF) | passMark(1)) : ((v | CTRL_A_OFF) & ~passMark(1));
        } else c[row] = v ^ (1 << bit);
        return { ...d, control: c };
      }
      const pc = (d.passControl || []).map((a) => (a ? a.slice() : a));
      while (pc.length < d.rows) pc.push(null);
      /* 未設定のパスは、いま出している値(指示記号)から始めて差分を取る */
      if (!pc[row]) pc[row] = Array.from({ length: passN }, (_, i) => (passN < 2 ? 0 : (i === 0 ? 0 : passMark(i + 1))));
      while (pc[row].length < passN) pc[row].push(passN < 2 ? 0 : passMark(pc[row].length + 1));
      pc[row][target - 1] = (pc[row][target - 1] || 0) ^ (1 << bit);
      return { ...d, passControl: pc };
    });
  }, [commit, say]);

  /* インデックスのマス目(段=左ガター / 目=上下の枠)の判定 */
  const toIndexHeader = useCallback((e) => {
    const p = toLocal(e);
    const px = p.x, py = p.y;
    const row = Math.floor((py - M.top) / cell);
    const col = Math.floor((px - M.left) / cell);
    if (px >= 0 && px < IDXW && row >= 0 && row < R) return { kind: "row", row };
    if (col >= 0 && col < S && (py < M.top || py >= M.top + R * cell)) return { kind: "col", col };
    return null;
  }, [toLocal, cell, S, R, M.left, M.top]);
  const selectHeader = useCallback((hh) => {
    if (hh.kind === "row") setSelection({ x: 0, y: hh.row, w: S, h: 1 });
    else setSelection({ x: hh.col, y: 0, w: 1, h: R });
  }, [S, R]);
  /* 長押し → 挿入/削除メニュー(gridMenuを流用。kindで行/列の項目を絞る) */
  const openHeaderMenu = useCallback((hh, x, y) => {
    setGridMenu(hh.kind === "row" ? { row: hh.row, col: 0, x, y, kind: "row" } : { row: 0, col: hh.col, x, y, kind: "col" });
  }, []);

  const paintAt = useCallback((g, x, y, col) => {
    if (x < 0 || x >= S || y < 0 || y >= R) return;
    g[y][x] = col;
    if (mirror) {
      const mx = S - 1 - x;
      if (mx !== x) g[y][mx] = col;
    }
  }, [S, R, mirror]);

  /* 長押しで呼ぶ「このマスを地色(色0)に戻す」。色番号もパレットも動かさず、そのマスだけを 0 にする
     (色を減らす操作は必ず「地色に戻す」に統一する。2.2 / 3.6)。ミラー中は対称のマスも戻す。 */
  const clearCellToGround = useCallback((x, y) => {
    if (x < 0 || x >= S || y < 0 || y >= R) return;
    const cur = docRef.current.grid;
    const mx = mirror ? S - 1 - x : x;
    if (cur[y][x] === 0 && cur[y][mx] === 0) { say("このマスはすでに地色です"); return; }
    commit((d) => { paintAt(d.grid, x, y, 0); return d; });
    say("長押し：このマスを地色(色0)に戻しました");
  }, [S, R, mirror, commit, paintAt, say]);

  /* 指で描くときの直前のタップ(1タップ目)。{x,y}=マス / t=時刻 / cx,cy=画面座標。
     ダブルタップが成立したら null に戻す(3回目のタップで続けて描かないようにするため)。 */
  const penTapRef = useRef(null);
  useEffect(() => { penTapRef.current = null; }, [tool, editMode]);
  /* この入力の種類はダブルタップでマークするか(DBLTAP_TYPES)。 */
  const needDblTap = (e) => DBLTAP_TYPES.includes(e.pointerType);
  /* ペンツールで、このタップが指のダブルタップの2タップ目になるか。成立すれば1タップ目のマス{x,y}を返す。
     同じマスか、1タップ目の押下位置から DBLTAP_SLOP 以内なら成立。2タップ目が制御マス・番号の帯・
     図案の外へわずかにはみ出しても、そちらの操作にはせずダブルタップとして扱う。 */
  const penDblTapCell = (e) => {
    const t = penTapRef.current;
    if (!t || tool !== "pen" || ghost || !needDblTap(e) || Date.now() - t.t > DBLTAP_MS) return null;
    const p = toCell(e);
    const same = p.inX && p.inY && p.x === t.x && p.y === t.y;
    if (!same && Math.hypot(e.clientX - t.cx, e.clientY - t.cy) > DBLTAP_SLOP) return null;
    return { x: t.x, y: t.y };
  };

  const onPointerDown = (e) => {
    const cv = gridCanvasRef.current;
    cv.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      /* 2本指: パン&ピンチへ移行(描きかけのストロークは取り消す) */
      if (gestureRef.current?.mode === "stroke") {
        strokeGridRef.current = null;
        const pd = undoRef.current.pop();
        if (pd) { docRef.current = pd; setDoc(pd); setHistVer((v) => v + 1); }
      }
      const pts = [...pointersRef.current.values()];
      const sc = scrollRef.current;
      gestureRef.current = {
        mode: "pan",
        cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2,
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        sl: sc.scrollLeft, st: sc.scrollTop, cell0: cell,
      };
      setDragShape(null);
      return;
    }
    /* 表示モード: 単一ポインタでの編集操作(描画・選択・ゴースト移動)は行わない。
       1本指スクロールは下層のスクロール領域が担い、2本指ズーム/パンは上で処理済み。 */
    if (!editMode) { gestureRef.current = null; return; }
    /* 配置中(ゴーストあり)は、キャンバスのどこを押してもゴーストの移動にする。図案の外(配置余白・番号の帯)に
       はみ出したゴーストもつかめるよう、制御マスや番号の帯の操作より先に判定する。 */
    if (ghost) {
      const gp = toCell(e, true);
      gestureRef.current = { mode: "ghost", ox: gp.x - ghost.x, oy: gp.y - ghost.y };
      ghostDragRef.current = true;
      return;
    }
    /* 指のダブルタップの2タップ目なら、はみ出していても制御マスや番号の帯の操作より先にこちらを採る */
    const dblCell = penDblTapCell(e);
    /* 制御ビットのマス目クリック(左の4列)。どのツールでも、ドロップリストで選んだパス(2色は色1パス)の
       ブザー・指示ビットを切り替える。以前はセル選択ツール(編集モードの初期ツール)では無効にしていたため、
       編集モードに入ってすぐ制御マスを押してもマークできなかった。 */
    const cc = toControlCell(e);
    if (!dblCell && cc.hit) { toggleControlBit(cc.row, cc.col, ctrlSel, ctrlPassN); gestureRef.current = null; return; }
    /* インデックスのマス目: 短タップ=行/列選択 / 長押し=挿入・削除メニュー */
    const hh = dblCell ? null : toIndexHeader(e);
    if (hh) {
      const sx = e.clientX, sy = e.clientY;
      const g = { mode: "header", hh, sx, sy, moved: false, fired: false, timer: null };
      g.timer = setTimeout(() => { if (gestureRef.current !== g) return; g.fired = true; openHeaderMenu(hh, sx, sy); }, LONGPRESS_MS);
      gestureRef.current = g;
      return;
    }
    const p = toCell(e);
    if (!dblCell && (!p.inX || !p.inY)) { gestureRef.current = null; return; }
    if (tool === "select") {
      if (selection && p.x >= selection.x && p.x < selection.x + selection.w && p.y >= selection.y && p.y < selection.y + selection.h) {
        /* 選択内ドラッグ = 移動(カット+ゴースト) */
        const cells = extractCells(doc.grid, selection);
        ghostDragRef.current = true;             // つかんだまま動かすので、余白は指を離してから広げる
        setGhost({ x: selection.x, y: selection.y, w: selection.w, h: selection.h, cells, src: { ...selection } });
        setSelection(null);
        gestureRef.current = { mode: "ghost", ox: p.x - selection.x, oy: p.y - selection.y };
        return;
      }
      /* 編集モードの初期ツールはセル選択なので、この状態でも長押しで地色に戻せるようにする。
         指が動けば範囲選択の操作とみなして長押しは取り消す。 */
      const gs = { mode: "select", x0: p.x, y0: p.y, sx: e.clientX, sy: e.clientY, timer: null, longFired: false };
      gs.timer = setTimeout(() => {
        if (gestureRef.current !== gs) return;
        gs.longFired = true; gs.timer = null;
        setSelection(null);
        clearCellToGround(p.x, p.y);
      }, LONGPRESS_MS);
      gestureRef.current = gs;
      setSelection({ x: p.x, y: p.y, w: 1, h: 1 });
      return;
    }
    if (tool === "fill") {
      commit((d) => { floodFill(d.grid, p.x, p.y, drawColor); return d; });
      gestureRef.current = null;
      return;
    }
    if (tool === "line" || tool === "rect") {
      /* 長押しはそのマスを地色へ。直線・矩形の待機中でも同じ操作ができるようにする */
      const gs = { mode: "shape", x0: p.x, y0: p.y, sx: e.clientX, sy: e.clientY, timer: null, longFired: false };
      gs.timer = setTimeout(() => {
        if (gestureRef.current !== gs) return;
        gs.longFired = true; gs.timer = null;
        setDragShape(null);
        clearCellToGround(p.x, p.y);
      }, LONGPRESS_MS);
      gestureRef.current = gs;
      setDragShape({ kind: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      return;
    }
    /* pen: ストロークは commit を通さない(開始時に1回だけ履歴を積み、ドラッグ中は doc を直接差し替える)。
       転送中ロックの判定だけはここで行う。 */
    if (busyBlocked()) { gestureRef.current = null; return; }
    /* 指のマークはダブルタップで行う(タッチペン・マウスは1タップで描く。DBLTAP_TYPES)。
       指の1タップ目では描かず、DBLTAP_MS 以内に同じ場所をもう一度タップしたときだけ、1タップ目のマスから
       描き始める(2タップ目からそのまま指を動かせば続けて描ける)。
       タブレット使用時に手やそでが触れてマークされてしまうのを防ぐため。
       長押しで地色(色0)に戻す操作は1タップ目からできる(消す操作なので誤って増えることがない)。 */
    if (needDblTap(e) && !dblCell) {
      const tap = { x: p.x, y: p.y, t: Date.now(), cx: e.clientX, cy: e.clientY };
      penTapRef.current = tap;
      const gw = { mode: "pentap", tap, sx: e.clientX, sy: e.clientY, timer: null, longFired: false };
      gw.timer = setTimeout(() => {
        if (gestureRef.current !== gw) return;
        gw.longFired = true; gw.timer = null;
        penTapRef.current = null;                // 長押しで消したので、続く2タップ目扱いにしない
        clearCellToGround(p.x, p.y);
      }, LONGPRESS_MS);
      gestureRef.current = gw;
      return;
    }
    penTapRef.current = null;
    /* 描き始めのマス。ダブルタップなら1タップ目のマス(2タップ目が隣のマスへずれても、狙ったマスに付ける) */
    const c0 = dblCell ? { ...p, x: dblCell.x, y: dblCell.y, inX: true, inY: true } : p;
    pushUndo(docRef.current);
    const g = cloneGrid(docRef.current.grid);
    paintAt(g, c0.x, c0.y, drawColor);
    strokeGridRef.current = g;
    lastCellRef.current = c0;
    /* 長押し(500ms)でそのマスを地色(色0)へ戻す。押した時点の描画と同じストローク＝同じ履歴1件に
       上書きするので、「元に戻す」1回で長押し前の状態へ戻る。指が動いたら長押しは取り消す。 */
    const gs = { mode: "stroke", sx: e.clientX, sy: e.clientY, timer: null, longFired: false };
    gs.timer = setTimeout(() => {
      if (gestureRef.current !== gs || !strokeGridRef.current) return;
      gs.longFired = true; gs.timer = null;
      paintAt(strokeGridRef.current, c0.x, c0.y, 0);
      setDoc((prev) => ({ ...prev, grid: strokeGridRef.current }));
      say("長押し：このマスを地色(色0)に戻しました");
    }, LONGPRESS_MS);
    gestureRef.current = gs;
    setDoc((prev) => ({ ...prev, grid: g }));
  };

  const onPointerMove = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ges = gestureRef.current;
    if (!ges) return;
    if (ges.mode === "header") {
      if (Math.abs(e.clientX - ges.sx) > 10 || Math.abs(e.clientY - ges.sy) > 10) { ges.moved = true; clearTimeout(ges.timer); }
      return;
    }
    if (ges.mode === "pan" && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()];
      const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      const sc = scrollRef.current;
      sc.scrollLeft = ges.sl - (cx - ges.cx);
      sc.scrollTop = ges.st - (cy - ges.cy);
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const nz = clamp(Math.round(ges.cell0 * (dist / ges.dist)), 6, maxCell);
      if (nz !== cellSize) setCellSize(nz);
      return;
    }
    if (ges.mode === "ghost" && ghost) {
      /* 置ける範囲(fitGhost)に収める。画面の端近くまで引いたら、その方向へスクロールする */
      const sc = scrollRef.current;
      if (sc) {
        const r = sc.getBoundingClientRect(), E = 28, V = Math.max(8, cell);
        if (e.clientY < r.top + E) sc.scrollTop -= V; else if (e.clientY > r.bottom - E) sc.scrollTop += V;
        if (e.clientX < r.left + E) sc.scrollLeft -= V; else if (e.clientX > r.right - E) sc.scrollLeft += V;
      }
      const gp = toCell(e, true);
      setGhost((g) => g && fitGhost({ ...g, x: gp.x - ges.ox, y: gp.y - ges.oy }));
      return;
    }
    const p = toCell(e);
    if (ges.mode === "select") {
      if (ges.timer && (Math.abs(e.clientX - ges.sx) > 10 || Math.abs(e.clientY - ges.sy) > 10)) { clearTimeout(ges.timer); ges.timer = null; }
      if (ges.longFired) return;                 // 長押しで地色に戻したあとは選択し直さない
      const x0 = clamp(Math.min(ges.x0, p.x), 0, S - 1), x1 = clamp(Math.max(ges.x0, p.x), 0, S - 1);
      const y0 = clamp(Math.min(ges.y0, p.y), 0, R - 1), y1 = clamp(Math.max(ges.y0, p.y), 0, R - 1);
      setSelection({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
      return;
    }
    if (ges.mode === "shape") {
      /* 指が動いたら長押し待ちは取り消す(図形を引く操作とみなす) */
      if (ges.timer && (Math.abs(e.clientX - ges.sx) > 10 || Math.abs(e.clientY - ges.sy) > 10)) { clearTimeout(ges.timer); ges.timer = null; }
      if (ges.longFired) return;
      setDragShape((s) => s && { ...s, x1: clamp(p.x, 0, S - 1), y1: clamp(p.y, 0, R - 1) });
      return;
    }
    if (ges.mode === "pentap") {
      /* 指が動いたら長押し待ちを取り消す。DBLTAP_SLOP を超えて動いたら(なぞった)ダブルタップ待ちも取り消す
         (なぞっただけでは何も起きない)。タップ中の小さな指のぶれではダブルタップ待ちを消さない。 */
      const dx = e.clientX - ges.sx, dy = e.clientY - ges.sy;
      if (ges.timer && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) { clearTimeout(ges.timer); ges.timer = null; }
      if (!ges.moved && Math.hypot(dx, dy) > DBLTAP_SLOP) {
        ges.moved = true;
        if (penTapRef.current === ges.tap) penTapRef.current = null;
      }
      return;
    }
    if (ges.mode === "stroke" && strokeGridRef.current) {
      if (ges.timer && (Math.abs(e.clientX - ges.sx) > 10 || Math.abs(e.clientY - ges.sy) > 10)) { clearTimeout(ges.timer); ges.timer = null; }
      if (ges.longFired) return;                 // 長押しで地色に戻したあとは描かない
      const last = lastCellRef.current;
      const g = strokeGridRef.current;
      bresenham(last.x, last.y, p.x, p.y, (x, y) => paintAt(g, x, y, drawColor));
      lastCellRef.current = p;
      setDoc((prev) => ({ ...prev, grid: g }));
    }
  };

  const onPointerUp = (e) => {
    pointersRef.current.delete(e.pointerId);
    const ges = gestureRef.current;
    /* ゴーストのドラッグを終えたら、止めていた配置余白を広げるために描き直す */
    if (ghostDragRef.current && pointersRef.current.size === 0) {
      ghostDragRef.current = false;
      setGhost((g) => g && { ...g });
    }
    /* インデックスのマス目: 短タップ(未発火・未移動)=選択 / 長押しは発火済み */
    if (ges?.mode === "header") {
      clearTimeout(ges.timer);
      if (!ges.fired && !ges.moved) selectHeader(ges.hh);
      gestureRef.current = null;
      return;
    }
    if (ges && ges.timer) { clearTimeout(ges.timer); ges.timer = null; }   // 長押し待ちの解除
    if (pointersRef.current.size > 0) return;
    /* 指の1タップ目。DBLTAP_MS 待って2タップ目が来なければ、マークしていないことを知らせる
       (ダブルタップが続けば penTapRef が入れ替わる/消えるので、この案内は出ない)。 */
    if (ges?.mode === "pentap") {
      const tap = ges.tap;
      if (!ges.longFired && !ges.moved && penTapRef.current === tap) {
        setTimeout(() => { if (penTapRef.current === tap) say("指で描くときはダブルタップでマークします"); }, DBLTAP_MS);
      }
      gestureRef.current = null;
      return;
    }
    if (ges?.mode === "shape" && ges.longFired) { setDragShape(null); strokeGridRef.current = null; gestureRef.current = null; return; }
    if (ges?.mode === "shape" && dragShape) {
      const sh = dragShape;
      commit((d) => {
        const put = (x, y) => { if (x >= 0 && x < S && y >= 0 && y < R) { d.grid[y][x] = drawColor; if (mirror) { const mx = S - 1 - x; d.grid[y][mx] = drawColor; } } };
        if (sh.kind === "line") bresenham(sh.x0, sh.y0, sh.x1, sh.y1, put);
        else {
          const x0 = Math.min(sh.x0, sh.x1), x1 = Math.max(sh.x0, sh.x1);
          const y0 = Math.min(sh.y0, sh.y1), y1 = Math.max(sh.y0, sh.y1);
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
            if (rectFilled || y === y0 || y === y1 || x === x0 || x === x1) put(x, y);
        }
        return d;
      });
      setDragShape(null);
    }
    strokeGridRef.current = null;
    gestureRef.current = null;
  };

  /* ============================== 選択・クリップボード操作 ============================== */
  const doCopy = useCallback(() => {
    if (!selection) return;
    setClipboard({ w: selection.w, h: selection.h, cells: extractCells(docRef.current.grid, selection) });
    say("コピーしました");
  }, [selection, say]);
  const doCut = useCallback(() => {
    if (!selection) return;
    setClipboard({ w: selection.w, h: selection.h, cells: extractCells(docRef.current.grid, selection) });
    commit((d) => { fillRegion(d.grid, selection, 0); return d; });
    say("カットしました");
  }, [selection, commit, say]);
  const doDelete = useCallback(() => {
    if (!selection) return;
    commit((d) => { fillRegion(d.grid, selection, 0); return d; });
  }, [selection, commit]);
  const doFillSel = useCallback(() => {
    if (!selection) return;
    commit((d) => { fillRegion(d.grid, selection, drawColor); return d; });
  }, [selection, commit, drawColor]);
  const doFlipSel = useCallback((dir) => {
    if (!selection) return;
    commit((d) => {
      let cells = extractCells(d.grid, selection);
      cells = dir === "h" ? flipCellsH(cells) : flipCellsV(cells);
      stampCells(d.grid, cells, selection.x, selection.y);
      return d;
    });
  }, [selection, commit]);
  const doRotSel = useCallback(() => {
    if (!selection) return;
    let clipped = false;
    let ns = selection;
    commit((d) => {
      const cells = rotCellsCW(extractCells(d.grid, selection));
      fillRegion(d.grid, selection, 0);
      clipped = stampCells(d.grid, cells, selection.x, selection.y);
      ns = {
        x: selection.x, y: selection.y,
        w: Math.min(cells[0].length, S - selection.x),
        h: Math.min(cells.length, R - selection.y),
      };
      return d;
    });
    setSelection(ns);
    if (clipped) say("はみ出した部分は切り捨てました");
  }, [selection, commit, S, R, say]);
  const doTile = useCallback(() => {
    if (!selection) return;
    const sel = selection;
    ask("選択範囲をパターン全体に敷き詰めます。よろしいですか?", () => {
      commit((d) => {
        const cells = extractCells(d.grid, sel);
        const w = sel.w, h = sel.h;
        for (let r = 0; r < R; r++) for (let c = 0; c < S; c++) {
          const rr = ((r - sel.y) % h + h) % h;
          const cc = ((c - sel.x) % w + w) % w;
          d.grid[r][c] = cells[rr][cc];
        }
        return d;
      });
      say("タイル複製しました");
    });
  }, [selection, commit, S, R, say]);
  const doPaste = useCallback(() => {
    if (!clipboard) return;
    /* パターン集からコピーしたもの(colors を持つ)は、貼り先の色数と一致しなければ置かずに警告する */
    const dc = clamp(doc.colors || 1, 1, MAX_COLOR_NO);
    if (clipboard.colors && clipboard.colors !== dc) { warn(colorMismatchMsg(clipboard.label || "コピーしたパターン", clipboard.colors, dc, "paste")); return; }
    const sc = scrollRef.current;
    let x = 0, y = 0;
    if (selection) { x = selection.x; y = selection.y; }
    else if (sc) {
      x = Math.round((sc.scrollLeft + sc.clientWidth / 2 - M.left) / cell - clipboard.w / 2);
      y = Math.round((sc.scrollTop + sc.clientHeight / 2 - ghostOY - M.top) / cell - clipboard.h / 2);
    }
    x = clamp(x, -clipboard.w + 1, S - 1); y = clamp(y, -clipboard.h + 1, R - 1);
    setSelection(null);
    setGhost(fitGhost({ x, y, w: clipboard.w, h: clipboard.h, cells: cloneGrid(clipboard.cells), colors: clipboard.colors, label: clipboard.label }));
  }, [clipboard, selection, cell, S, R, ghostOY, doc.colors]);
  const ghostTransform = useCallback((fn) => {
    setGhost((g) => {
      if (!g) return g;
      const cells = fn(g.cells);
      return fitGhost({ ...g, cells, w: cells[0].length, h: cells.length });
    });
  }, [S, R]);
  /* ゴーストを図案へ貼る。expand のときは、はみ出した上と右のぶんだけ段・目を増やしてから貼る。
     増やすのは最上段の上と右端の右だけなので、既存の段番号(段1=最下段)と目番号(目1=左端)は変わらない。
     増やした段の制御4bitは0(passControl は null)。左端・最下段より外の部分は切り捨てる。
     段・目の追加と貼り付けは1回の commit で行うので、「元に戻す」1回で貼る前の寸法と図案に戻る。
     図案に色数の外の色番号が入ったときの色数の引き上げは commit が行う。 */
  const pasteGhost = useCallback((g, expand) => {
    const addTop = expand ? Math.max(0, -g.y) : 0;
    const addRight = expand ? Math.max(0, g.x + g.w - S) : 0;
    const ns = S + addRight, nr = R + addTop;
    const raise = maxColorNo(g.cells) > clamp(docRef.current.colors || 1, 1, MAX_COLOR_NO);
    let clipped = false, done = false;
    commit((d) => {
      let grid = d.grid, control = d.control, passControl = d.passControl;
      if (addTop || addRight) {
        grid = [
          ...Array.from({ length: addTop }, () => new Uint8Array(ns)),
          ...d.grid.map((row) => { const w = new Uint8Array(ns); w.set(row, 0); return w; }),
        ];
        const oc = d.control || [], opc = d.passControl || [];
        control = Array.from({ length: nr }, (_, r) => (r < addTop ? 0 : (oc[r - addTop] || 0)));
        passControl = Array.from({ length: nr }, (_, r) => { const a = r < addTop ? null : opc[r - addTop]; return a ? a.slice() : null; });
      }
      if (g.src) fillRegion(grid, { ...g.src, y: g.src.y + addTop }, 0);
      clipped = stampCells(grid, g.cells, g.x, g.y + addTop);
      done = true;
      return { ...d, stitches: ns, rows: nr, grid, control, passControl };
    });
    if (!done) return;                                // 転送中などで貼れなかったときはゴーストを残す
    if (addTop || addRight) { setSInput(String(ns)); setRInput(String(nr)); }
    setGhost(null);
    const size = [addRight && `目数 ${S}→${ns}`, addTop && `段数 ${R}→${nr}`].filter(Boolean).join("・");
    const msg = size ? `${size} に広げて貼り付けました${clipped ? "（左端・最下段の外は切り捨て）" : ""}`
      : (clipped ? "はみ出した部分は切り捨てました" : "");
    if (msg) { if (raise) setTimeout(() => say(msg), 2200); else say(msg); }
  }, [S, R, commit, say]);
  /* 確定。ゴーストが目数・段数の外(右端の右・最上段の上)へはみ出していれば、警告して広げるかを尋ねる。
     キャンセルならゴーストを残し、位置を直せるようにする。 */
  const confirmGhost = useCallback(() => {
    if (!ghost) return;
    const g = ghost;
    /* 置いたあとに色数を変えた場合も、確定の時点で一致を確かめる。一致しなければ貼らずに配置を残す */
    const dc = clamp(doc.colors || 1, 1, MAX_COLOR_NO);
    if (g.colors && g.colors !== dc) { warn(colorMismatchMsg(g.label || "コピーしたパターン", g.colors, dc, "confirm")); return; }
    const addTop = Math.max(0, -g.y), addRight = Math.max(0, g.x + g.w - S);
    if (!addTop && !addRight) { pasteGhost(g, false); return; }
    const cut = [g.x < 0 && "左端", g.y + g.h > R && "最下段"].filter(Boolean);
    const over = [addRight && "目数", addTop && "段数"].filter(Boolean).join("と");
    setConfirmBox({
      msg: `⚠ 貼り付ける位置がパターンの${over}を超えています。\n`
        + `パターンを広げてから貼り付けます。\n`
        + (addRight ? `目数: ${S} → ${S + addRight}（右端に${addRight}目追加）\n` : "")
        + (addTop ? `段数: ${R} → ${R + addTop}（最上段の上に${addTop}段追加）\n` : "")
        + `既存の段番号・目番号は変わりません。`
        + (cut.length ? `\n${cut.join("・")}より外の部分は切り捨てます。` : "")
        + `\n（「元に戻す」1回で戻せます）`,
      okLabel: "広げて貼り付け", onOk: () => pasteGhost(g, true),
      altLabel: "広げずに切り捨て", onAlt: () => pasteGhost(g, false),
    });
  }, [ghost, S, R, pasteGhost, doc.colors]);
  const cancelGhost = useCallback(() => setGhost(null), []);
  const selectAll = useCallback(() => { setTool("select"); setSelection({ x: 0, y: 0, w: S, h: R }); }, [S, R]);

  /* ============================== 全体操作・パレット・入出力 ============================== */
  const performResize = (ns, nr) => {
    commit((d) => {
      /* アンカー: 段は最下段(段1)、目は左端(目1)を固定する。画面の番号付け(段1=最下段 / 目1=左端)に合わせる。
         grid[0]が最上段なので、段を増やすと上端に空段が付き、目を増やすと右端に空目が付く。 */
      const ng = mkGrid(nr, ns, 0);
      for (let r = 0; r < nr; r++) for (let c = 0; c < ns; c++) {
        const or = r - (nr - R), oc = c;
        if (or >= 0 && or < R && oc < S) ng[r][c] = d.grid[or][oc];
      }
      const nc = Array.from({ length: nr }, (_, r) => {
        const or = r - (nr - R);
        return (or >= 0 && or < R && d.control) ? (d.control[or] || 0) : 0;
      });
      const opc = d.passControl || [];
      const npc = Array.from({ length: nr }, (_, r) => { const or = r - (nr - R); return (or >= 0 && or < R && opc[or]) ? opc[or].slice() : null; });
      return { ...d, stitches: ns, rows: nr, grid: ng, control: nc, passControl: npc };
    });
    setSelection(null); setGhost(null);
  };
  const applySize = () => {
    const ns = clamp(parseInt(sInput, 10) || 0, 1, MAX_S);
    const nr = clamp(parseInt(rInput, 10) || 0, 1, MAX_R);
    if (!ns || !nr) return;
    setSInput(String(ns)); setRInput(String(nr));
    if (ns === S && nr === R) return;
    /* 縮小で消えるデータの確認(段は最下段=段1、目は左端=目1を保持 → 上端の段と右端の目が消える) */
    let loss = false;
    if (ns < S || nr < R) {
      for (let r = 0; r < R && !loss; r++) for (let c = 0; c < S; c++) {
        if ((r < R - nr || c >= ns) && doc.grid[r][c] !== 0) { loss = true; break; }
      }
    }
    if (loss) ask("縮小により、はみ出すパターンは削除されます。よろしいですか?", () => performResize(ns, nr));
    else performResize(ns, nr);
  };
  const applyPreset = (ns, nr) => { setSInput(String(ns)); setRInput(String(nr)); };
  /* 図案に何か描かれているか(地色0以外のマスがあるか) */
  const hasPattern = () => doc.grid.some((row) => row.some((v) => v !== 0));
  /* 新規パターン。目数・段数の入力欄の値で空の図案を作る(値を変えてから押せばその大きさで始まる)。
     図案が残っているときは、消す前にパターン集へ追加するかを尋ねる。 */
  const startNew = () => {
    const ns = clamp(parseInt(sInput, 10) || S, 1, MAX_S);
    const nr = clamp(parseInt(rInput, 10) || R, 1, MAX_R);
    const fresh = () => {
      setSInput(String(ns)); setRInput(String(nr));
      commitLoaded((d) => ({ ...d, stitches: ns, rows: nr, grid: mkGrid(nr, ns, 0), control: Array(nr).fill(0), passControl: [] }));
      setSelection(null); setGhost(null);
      say(`新規パターン(${ns}目 × ${nr}段)にしました`);
    };
    if (!hasPattern()) { fresh(); return; }        // 何も描かれていなければそのまま新規
    setConfirmBox({
      msg: `今のパターンを消して新規(${ns}目 × ${nr}段)にします。\n消す前にパターン集へ追加しますか?\n`
        + `(消したあとでも「元に戻す」で戻せます)`,
      okLabel: `追加して新規(${srName(library.length)})`,
      onOk: () => {
        if (library.length >= MAX_LIB) {
          warn(`パターン集は ${MAX_LIB} 件までです。\nすでに ${library.length} 件あるので追加できません。\n不要なパターンを削除してから新規にしてください。`);
          return;                                   // 追加できないときは図案を消さない
        }
        addToLibrary(); fresh();
      },
      altLabel: "追加せずに新規", onAlt: fresh,
    });
  };

  const doShift = useCallback((dx, dy) => {
    commit((d) => {
      const ng = mkGrid(R, S, 0);
      for (let r = 0; r < R; r++) for (let c = 0; c < S; c++)
        ng[(r + dy + R) % R][(c + dx + S) % S] = d.grid[r][c];
      /* 段を動かしたら制御4bitも同じだけ回り込ませる(段と制御の対応を崩さない)。dx方向は段が変わらないので不要。 */
      const oc = d.control || [], opc = d.passControl || [];
      const nc = Array.from({ length: R }, (_, r) => oc[((r - dy) % R + R) % R] || 0);
      const npc = Array.from({ length: R }, (_, r) => { const a = opc[((r - dy) % R + R) % R]; return a ? a.slice() : null; });
      return { ...d, grid: ng, control: nc, passControl: npc };
    });
  }, [commit, S, R]);
  const doFlipAll = useCallback((dir) => {
    /* 上下反転は制御4bitも段と一緒に反転させる。左右反転は段が変わらないので制御はそのまま。 */
    commit((d) => {
      if (dir === "h") return { ...d, grid: flipCellsH(d.grid) };
      const oc = d.control || [], opc = d.passControl || [];
      const nc = Array.from({ length: d.rows }, (_, r) => oc[d.rows - 1 - r] || 0);
      const npc = Array.from({ length: d.rows }, (_, r) => { const a = opc[d.rows - 1 - r]; return a ? a.slice() : null; });
      return { ...d, grid: flipCellsV(d.grid), control: nc, passControl: npc };
    });
  }, [commit]);
  const doClearAll = () => {
    ask("パターンを全消去します。よろしいですか?", () => {
      commit((d) => ({ ...d, grid: mkGrid(R, S, 0) }));
      setSelection(null); setGhost(null);
    });
  };
  const doSwapColors = useCallback((a, b) => {
    commit((d) => {
      for (let r = 0; r < R; r++) for (let c = 0; c < S; c++) {
        if (d.grid[r][c] === a) d.grid[r][c] = b;
        else if (d.grid[r][c] === b) d.grid[r][c] = a;
      }
      return d;
    });
  }, [commit, S, R]);

  /* ---- 段(行)・目(列)の挿入/削除 ----
     grid[0]が上端。at は配列index(0=上端 / 0=左端)。挿入は地色の段/目を入れる。
     まとめて n 本を1回の commit で処理するので、履歴は何本でも1件になる。
     表示上の番号は段が最下段=1(表示段 = R − 内部添字)、目が左端=1(目番号 = 内部添字 + 1)。 */
  const insertRowsAt = useCallback((at, n) => {
    if (R + n > MAX_R) { say(`段数は最大${MAX_R}段です`); return; }
    const a = clamp(at, 0, R);
    commit((d) => {
      const g = d.grid.slice(), c = (d.control || []).slice();
      const pc = (d.passControl || []).map((x) => (x ? x.slice() : x));
      g.splice(a, 0, ...Array.from({ length: n }, () => new Uint8Array(S)));
      c.splice(a, 0, ...Array(n).fill(0));
      pc.splice(a, 0, ...Array(n).fill(null));
      return { ...d, rows: R + n, grid: g, control: c, passControl: pc };
    });
    setRInput(String(R + n)); setSelection(null); setGhost(null);
    say(`${n}段追加しました（段数 ${R} → ${R + n}）`);
  }, [commit, R, S, say]);

  const deleteRowsAt = useCallback((at, n) => {
    if (R - n < 1) { say("最後の1段は削除できません"); return; }
    const a = clamp(at, 0, R - n);
    commit((d) => {
      const g = d.grid.slice(), c = (d.control || []).slice();
      const pc = (d.passControl || []).map((x) => (x ? x.slice() : x));
      g.splice(a, n); c.splice(a, n); pc.splice(a, n);
      return { ...d, rows: R - n, grid: g, control: c, passControl: pc };
    });
    setRInput(String(R - n)); setSelection(null); setGhost(null);
    say(`${n}段削除しました（段数 ${R} → ${R - n}）。元に戻すで戻せます`);
  }, [commit, R, say]);

  const insertColsAt = useCallback((at, n) => {
    if (S + n > MAX_S) { say(`目数は最大${MAX_S}目です`); return; }
    const a = clamp(at, 0, S);
    commit((d) => {
      /* 行は Uint8Array なので splice は使えない。n目ぶん長い配列を作り、前後を set で写す
         (間に入る n 目は 0 = 地色のまま)。 */
      const g = d.grid.map((r) => {
        const nr = new Uint8Array(r.length + n);
        nr.set(r.subarray(0, a), 0);
        nr.set(r.subarray(a), a + n);
        return nr;
      });
      return { ...d, stitches: S + n, grid: g };
    });
    setSInput(String(S + n)); setSelection(null); setGhost(null);
    say(`${n}目追加しました（目数 ${S} → ${S + n}）`);
  }, [commit, S, say]);

  const deleteColsAt = useCallback((at, n) => {
    if (S - n < 1) { say("最後の1目は削除できません"); return; }
    const a = clamp(at, 0, S - n);
    commit((d) => {
      const g = d.grid.map((r) => {
        const nr = new Uint8Array(r.length - n);
        nr.set(r.subarray(0, a), 0);
        nr.set(r.subarray(a + n), a);
        return nr;
      });
      return { ...d, stitches: S - n, grid: g };
    });
    setSInput(String(S - n)); setSelection(null); setGhost(null);
    say(`${n}目削除しました（目数 ${S} → ${S - n}）。元に戻すで戻せます`);
  }, [commit, S, say]);

  /* 削除は図案が失われるので必ず確認する。対象の番号・本数と、寸法がどう変わるかを示す。 */
  const confirmDeleteRows = useCallback((at, n) => {
    if (R - n < 1) { warn("最後の1段は削除できません。\n段数を増やしてから削除してください。"); return; }
    const hi = R - at, lo = R - (at + n - 1);                  // 表示段番号(段1=最下段)
    const where = n === 1 ? `段${hi}` : `段${lo}〜段${hi}（${n}段）`;
    ask(`${where} を削除します。\nその段に描いた図案は失われます。\n段数: ${R} → ${R - n}\n`
      + `（実行後に「元に戻す」で戻せます）\nよろしいですか?`, () => deleteRowsAt(at, n));
  }, [R, ask, warn, deleteRowsAt]);

  const confirmDeleteCols = useCallback((at, n) => {
    if (S - n < 1) { warn("最後の1目は削除できません。\n目数を増やしてから削除してください。"); return; }
    const where = n === 1 ? `目${at + 1}` : `目${at + 1}〜目${at + n}（${n}目）`;
    ask(`${where} を削除します。\nその目に描いた図案は失われます。\n目数: ${S} → ${S - n}\n`
      + `（実行後に「元に戻す」で戻せます）\nよろしいですか?`, () => deleteColsAt(at, n));
  }, [S, ask, warn, deleteColsAt]);

  /* 右クリック/長押しメニューからの1本ぶんの操作。削除は上の確認ダイアログを通す。 */
  const insertRow = useCallback((row, where) => insertRowsAt(where === "below" ? row + 1 : row, 1), [insertRowsAt]);
  const deleteRow = useCallback((row) => confirmDeleteRows(clamp(row, 0, R - 1), 1), [confirmDeleteRows, R]);
  const insertCol = useCallback((col, where) => insertColsAt(where === "right" ? col + 1 : col, 1), [insertColsAt]);
  const deleteCol = useCallback((col) => confirmDeleteCols(clamp(col, 0, S - 1), 1), [confirmDeleteCols, S]);

  /* 「選択・配置」パレットからの段・目の削除。選択範囲があればその段/目をまとめて、無いときは最上段・右端の1本を対象にする
     (こちら側なら残る段番号・目番号(段1=最下段 / 目1=左端)が動かない)。必ず確認ダイアログを通す。 */
  const palDelRows = () => { const t = selection ? { at: selection.y, n: selection.h } : { at: 0, n: 1 }; confirmDeleteRows(t.at, t.n); };
  const palDelCols = () => { const t = selection ? { at: selection.x, n: selection.w } : { at: S - 1, n: 1 }; confirmDeleteCols(t.at, t.n); };
  /* 段・目を足す(段↑+ / 段↓+ / 目←+ / 目→+)。足す側をボタンで選ぶ。
     選択範囲があれば、その上・下(段)／左・右(目)に、選択の段数・目数ぶん足す。無ければ図案の端(最上段の上・最下段の下／
     左端・右端)に1本足す。以前の「段+」「目+」はどちら側に足すのかが分かりにくかったので、この4つに置き換えた。
     段番号は最下段=段1、目番号は左端=目1なので、足した位置より上の段・右の目は番号が n ずつ大きくなる。
     制御4bitは段と一緒に動き、足した段は0(passControl は null)。
     選択範囲は消さずに図案と一緒にずらす(同じ選択のまま続けて押せる)。選択が無く配置中のゴーストがあるときは、
     ゴーストも図案と一緒にずらすので、置いたまま端を広げて確定できる。1回の commit なので「元に戻す」1回で戻る。 */
  const addLines = (dir) => {
    const horiz = dir === "left" || dir === "right";
    const sel = selection && !ghost ? selection : null;
    const n = sel ? (horiz ? sel.w : sel.h) : 1;
    const at = dir === "left" ? (sel ? sel.x : 0)
      : dir === "right" ? (sel ? sel.x + sel.w : S)
      : dir === "up" ? (sel ? sel.y : 0)
      : (sel ? sel.y + sel.h : R);                           // grid[0] が最上段
    if (horiz && S + n > MAX_S) { say(`目数は最大${MAX_S}目です（いま${S}目・${n}目は足せません）`); return; }
    if (!horiz && R + n > MAX_R) { say(`段数は最大${MAX_R}段です（いま${R}段・${n}段は足せません）`); return; }
    let done = false;
    commit((d) => {
      done = true;
      if (horiz) {
        /* 行は Uint8Array なので splice は使えない。n目長い配列へ、足す位置の前後を set で写す(間は地色0) */
        const g = d.grid.map((row) => {
          const w = new Uint8Array(row.length + n);
          w.set(row.subarray(0, at), 0);
          w.set(row.subarray(at), at + n);
          return w;
        });
        return { ...d, stitches: S + n, grid: g };
      }
      const g = d.grid.slice(); g.splice(at, 0, ...Array.from({ length: n }, () => new Uint8Array(S)));
      const oc = d.control || [], opc = d.passControl || [];
      const c = Array.from({ length: R }, (_, r) => oc[r] || 0); c.splice(at, 0, ...Array(n).fill(0));
      const pc = Array.from({ length: R }, (_, r) => (opc[r] ? opc[r].slice() : null)); pc.splice(at, 0, ...Array(n).fill(null));
      return { ...d, rows: R + n, grid: g, control: c, passControl: pc };
    });
    if (!done) return;                                     // 転送中などで変えられなかった
    /* 足した位置から先(右・下)にあるものは n ずれる。選択は「左・上に足した」ときだけずれる。
       ゴーストは端に足したときなので、左端・最上段に足したときだけずらす。 */
    const dx = dir === "left" ? n : 0, dy = dir === "up" ? n : 0;
    if (dx || dy) {
      if (sel) setSelection((cur) => cur && { ...cur, x: cur.x + dx, y: cur.y + dy });
      else setGhost((gh) => gh && { ...gh, x: gh.x + dx, y: gh.y + dy, src: gh.src && { ...gh.src, x: gh.src.x + dx, y: gh.src.y + dy } });
    }
    if (horiz) setSInput(String(S + n)); else setRInput(String(R + n));
    const where = horiz
      ? (sel ? `選択した目の${dir === "left" ? "左" : "右"}に${n}目` : `${dir === "left" ? "左端" : "右端"}に${n}目`)
      : (sel ? `選択した段の${dir === "up" ? "上" : "下"}に${n}段` : `${dir === "up" ? "最上段の上" : "最下段の下"}に${n}段`);
    const size = horiz ? `目数 ${S} → ${S + n}` : `段数 ${R} → ${R + n}`;
    const renum = horiz ? (at < S ? `。右側の目の番号は${n}ずつ大きくなります` : "") : (at > 0 ? `。上側の段の番号は${n}ずつ大きくなります` : "");
    say(`${where}追加しました（${size}${renum}）`);
  };

  /* palette */
  /* 色数(地色を含めた総色数)を切り替える。doc.colors = 総色数 − 1。パレットは8スロット固定のまま、
     減らしたぶんの色番号のマスは地色(0)へ戻す。色数フィールドにはパス数 passCount(doc.colors) が入る。 */
  const applyColorCount = (total) => {
    const n = clamp(total - 1, 1, MAX_COLOR_NO);
    const cur = clamp(doc.colors || 1, 1, MAX_COLOR_NO);
    if (n === cur) return;
    /* パレットのスロットは常に8のまま。色番号も動かさない。減らしたぶんの色番号は
       「使えない色」になり、そのマスは地色へ戻す(他の色へ寄せると図案が変わってしまう)。 */
    const run = () => {
      commit((d) => {
        const g = d.grid.map((row) => {
          let hit = false;
          for (let i = 0; i < row.length; i++) if (row[i] > n) { hit = true; break; }
          if (!hit) return row;
          const o = row.slice();
          for (let i = 0; i < o.length; i++) if (o[i] > n) o[i] = 0;
          return o;
        });
        /* 使わなくなったパスの制御4bitも落とす(制御帯の本数を色数に追従させる) */
        const pc = (d.passControl || []).map((a) => (a ? a.slice(0, n) : a));
        return { ...d, palette: padPalette(d.palette), grid: g, colors: n, passControl: pc };
      });
      setSelColor((c) => clamp(c, 0, n));
      say(`${n + 1}色（地色+${n}色 = ${passCount(n)}パス${passCount(n) >= 2 ? "、最終パスは地色" : ""}）にしました`);
    };
    if (n < cur) {
      /* 削除される色番号と、その使用マス数を数えて提示する */
      const used = [];
      for (let k = n + 1; k <= cur; k++) {
        let cnt = 0;
        for (let r = 0; r < R; r++) for (let c = 0; c < S; c++) if (doc.grid[r][c] === k) cnt++;
        used.push({ k, cnt });
      }
      const hit = used.filter((u) => u.cnt > 0);
      if (hit.length) {
        ask(
          `${cur + 1}色 → ${n + 1}色 に減らします。\n`
          + `削除する色番号: ${hit.map((u) => `色${u.k}（${u.cnt}マス）`).join(" / ")}\n`
          + "これらのマスは地色に戻ります。よろしいですか?",
          run
        );
        return;
      }
    }
    run();
  };
  /* 色番号はスロット固定なので、パレット操作は「その番号の表示色を変える」だけ。
     ─ 注意 ─ 画面外に置いた input[type=color] に .click() を送る方式は使えない。
     display:none の色入力はブラウザがピッカーを開かない(file入力と違う)。実体のある
     入力をスウォッチメニュー内に描き、そこで選ばせる。#RRGGBB の直接入力も受ける。 */
  /* カラー入力はドラッグ中に何度も発火するので、ひと続きの操作を1履歴にまとめる。
     最初の変更でだけ undo を積み、以降は doc を直接差し替える(commitを通すと履歴が埋まる)。 */
  const colorSessRef = useRef(null);
  const setSlotColor = (index, hex, live) => {
    const h = normHex(hex);
    if (h === null) { say("色は #RRGGBB の形式で指定してください"); return false; }
    if (busyBlocked()) return false;
    const prev = docRef.current;
    if (padPalette(prev.palette)[index] === h) { colorSessRef.current = live ? index : null; return true; }
    if (!live || colorSessRef.current !== index) pushUndo(prev);
    colorSessRef.current = live ? index : null;
    const pal = padPalette(prev.palette);
    pal[index] = h;
    const next = { ...prev, palette: pal };
    docRef.current = next;
    setDoc(next);
    return true;
  };
  const endColorSession = () => { colorSessRef.current = null; };
  /* その色番号のマスを地色へ戻す。色番号もパレットのスロットも動かさない
     (番号を詰めると図案とパスの対応が変わってしまうため)。 */
  const clearColor = (idx) => {
    if (idx === 0) return;
    setSwatchMenu(null);
    let used = 0;
    for (let r = 0; r < R; r++) for (let c = 0; c < S; c++) if (doc.grid[r][c] === idx) used++;
    if (!used) { say(`色${idx} は使われていません`); return; }
    ask(`色${idx} の ${used} マスを地色に戻します。色番号はそのまま残ります。よろしいですか?`, () => {
      commit((d) => {
        const g = d.grid.map((row) => {
          const o = row.slice();
          for (let i = 0; i < o.length; i++) if (o[i] === idx) o[i] = 0;
          return o;
        });
        return { ...d, grid: g };
      });
      say(`色${idx} のマスを地色に戻しました`);
    });
  };
  const replaceColor = (from, to) => {
    commit((d) => {
      for (let r = 0; r < R; r++) for (let c = 0; c < S; c++)
        if (d.grid[r][c] === from) d.grid[r][c] = to;
      return d;
    });
    setSwatchMenu(null);
    say("一括置換しました");
  };

  /* IO */
  const exportJSON = () => {
    /* grid の行は Uint8Array なので、JSON化の前に通常配列へ戻す(そのままだと {"0":…} になる) */
    /* 種類(format)・版(version: 中身に必要な最も低い版)・保存したアプリ(app)を先頭に書く */
    const ctl = (doc.control || []).slice(0, R);
    const data = { format: PAT_FORMAT, version: fileVersionFor([ctl]), app: APP_REV, savedAt: new Date().toISOString(),
      stitches: S, rows: R, palette: doc.palette, gaugeRatio: doc.gaugeRatio,
      grid: doc.grid.map((row) => Array.from(row)), control: (doc.control || []).slice(0, R),
      passControl: (doc.passControl || []).slice(0, R).map((a) => (a ? a.slice() : null)), colors: doc.colors || 1 };
    const text = JSON.stringify(data);
    /* 保存前に読み戻し、このアプリで同じ図案・制御に戻ることを確かめる(戻らなければ保存しない) */
    let back = null;
    try { back = parsePatternJSON(text).doc; } catch { back = null; }
    const same = !!back && back.stitches === S && back.rows === R
      && back.grid.every((row, r) => row.every((v, c) => v === doc.grid[r][c]))
      && back.control.every((v, r) => v === ((ctl[r] | 0) & 0x1f));
    if (!same) { warn("保存前の読み戻し検査で、元のパターンと一致しない内容がありました。\nファイルは保存していません。"); return; }
    downloadBlob(new Blob([text], { type: "application/json" }), "knit-pattern.json");
    say(`現在のパターンを JSON（v${data.version}）で保存しました`);
  };
  const importJSON = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      let res;
      try { res = parsePatternJSON(reader.result); }
      catch (err) { warn(`パターンを読み込めませんでした。\n${err.message}`); return; }
      if (res.library) { openLibraryText(reader.result, f.name); return; }   // パターン集ファイル
      const nd = res.doc;
      commitLoaded(() => nd);
      setSInput(String(nd.stitches)); setRInput(String(nd.rows));
      setSelection(null); setGhost(null);
      say(`読み込みました（v${res.version}${res.app ? `・${res.app} で保存` : "・旧形式"}）`);
    };
    reader.onerror = () => warn("ファイルを読み取れませんでした");
    reader.readAsText(f);
    e.target.value = "";
  };
  /* ---- SR形式テキスト(パターン集) ---- */
  const srName = (i) => "SR" + String(i).padStart(5, "0");
  /* SRDSカード上の格納ディレクトリ。100件ごとに区切り、通し番号iを100で割った整数部を用いる。
     i=0..99 → D000 / i=100..199 → D001 / i=200..299 → D002 … */
  const srdsDir = (i) => "D" + String(Math.floor(i / 100)).padStart(3, "0");

  /* パターン集からの削除。パターンNo は配列の位置から srName(i) で導出するため、
     1件抜くと以降のNoは自動的に繰り上がる（振り直しにあたる）。
     「新規」ハイライトの範囲も同じぶんだけずらし、削除後に別のパターンを指さないようにする。 */
  const deleteEntry = (i) => {
    const e = library[i];
    if (!e) return;
    const name = srName(i), tail = library.length - 1 - i;
    ask(
      `${name}（${e.s}目 × ${e.r}段）を削除します。`
      + (tail > 0 ? `以降の ${tail} 件はパターンNoが1つずつ繰り上がります。` : "")
      + "よろしいですか?",
      () => {
        setLibrary((l) => l.filter((_, j) => j !== i));
        setLibDirty(true);
        setPickerNew((p) => {
          if (!p) return null;
          const from = i < p.from ? p.from - 1 : p.from;
          const to = i < p.to ? p.to - 1 : p.to;
          return to > from ? { from, to } : null;
        });
        say(tail > 0 ? `${name} を削除し、以降のパターンNoを振り直しました` : `${name} を削除しました`);
      }
    );
  };
  /* 現在のパターンをパターン集エントリへ変換する。表現は常に grid + palette。
     colors は地色を除いた色数 c で、パス数(色数フィールド)は passCount(c)。 */
  const docEntry = () => {
    /* 書き出す色数は、設定した色数と実際に使っている最大の色番号の大きいほう。
       色番号は詰め直さない(色3だけを使った図案は色3=第3パスのまま。第1・第2パスは空段になる)。 */
    const n = clamp(Math.max(maxColorNo(doc.grid), doc.colors || 0), 1, MAX_COLOR_NO);
    return {
      s: S, r: R,
      grid: cloneGrid(doc.grid),
      palette: padPalette(doc.palette),
      colors: n,
      control: (doc.control || []).slice(0, R),
      passControl: (doc.passControl || []).slice(0, R).map((a) => (a ? a.slice() : a)),
    };
  };
  /* 追加ボタン(ツールバー・パターン集ウィンドウ)の状態。上限に達したら押せない。 */
  const libFull = library.length >= MAX_LIB;
  const libAddTitle = libFull
    ? `現在のパターンをパターン集に追加(上限 ${MAX_LIB} 件に達しています)`
    : `現在のパターンをパターン集に追加(${srName(library.length)} として登録)`;
  /* 促しの色と文言 */
  const patFilled = useMemo(() => doc.grid.some((row) => row.some((v) => v !== 0)), [doc.grid]);
  const addHint = patDirty && patFilled && !libFull;
  const saveHint = libDirty && library.length > 0;
  const ADD_HINT = "#34c07a", SAVE_HINT = "#3b82f6";
  const addTitle = addHint ? `${libAddTitle}（編集したパターンがまだパターン集に入っていません）` : libAddTitle;
  const saveTitle = library.length
    ? `パターン集を保存(全データ・JSON)${saveHint ? "（パターン集にまだ保存していない変更があります）" : ""}`
    : "パターン集を保存(パターン集が空のため保存できません)";
  const hintBtn = (on, bg, fg) => (on ? { background: bg, color: fg } : { color: "#9aa2b0" });
  const addToLibrary = () => {
    if (library.length >= MAX_LIB) {
      warn(`パターン集は ${MAX_LIB} 件までです。\nすでに ${library.length} 件あるので、これ以上は登録できません。\n不要なパターンを削除してから追加してください。`);
      return;
    }
    const e = docEntry();
    setLibrary((l) => [...l, e]);
    markDocClean(); setLibDirty(true);           // 登録済み → 次は保存を促す
    const note = e.colors > 1 ? `(地色+${e.colors}色)` : "";
    say(`${srName(library.length)} として追加しました${note}`);
  };
  /* パターン集の全パターンを1枚のU-BOXカード像として書き出す */
  const exportUBox = () => {
    const entries = library.length ? library : [docEntry()];
    const run = (list) => {
      downloadBlob(new Blob([buildUBox(list)], { type: "application/octet-stream" }), "U-BOX.bin");
      say(`${list.length}パターンをU-BOX形式で書き出しました`);
    };
    /* 収録数は1バイト(0x06 = 収録数 − 1)なので256件まで。黙って切り詰めず、書き出す範囲を確認してもらう */
    if (entries.length > UBOX_MAX) {
      ask(
        `U-BOXカード1枚に入るのは ${UBOX_MAX} 件までです。\n`
        + `パターン集は ${entries.length} 件あります。\n`
        + `先頭の ${UBOX_MAX} 件（${srName(0)}〜${srName(UBOX_MAX - 1)}）だけを書き出し、残り ${entries.length - UBOX_MAX} 件は含めません。よろしいですか?`,
        () => run(entries.slice(0, UBOX_MAX))
      );
      return;
    }
    run(entries);
  };
  /* 図案行は最下段(段1)から書き出す。内部 lines は index0=最上段なので反転する(parseSRText と対) */
  /* SRテキストは2値のみ。色番号グリッドから導出する(色0=地、それ以外がX) */
  const srTextOf = (entries) => entries.map((e, i) => [srName(i), `${e.s},${e.r}`, ...gridLines(e.grid).reverse()].join("\n")).join("\n\n") + "\n";
  const exportSRText = () => {
    const entries = library.length ? library : [docEntry()];
    downloadBlob(new Blob([srTextOf(entries)], { type: "text/plain" }), "knit-patterns-SR.txt");
    say(`${entries.length}パターンをテキスト書き出ししました`);
  };
  /* 現在のパターンだけを SRテキストで保存する(パターン集の内容に影響されない)。見出しは SR00000。
     SRテキストは2値なので、多色は地色以外の目をすべて X にして書き出し、その旨を知らせる。 */
  const exportSRTextCurrent = () => {
    const e = docEntry();
    downloadBlob(new Blob([srTextOf([e])], { type: "text/plain" }), "knit-pattern-SR.txt");
    say(`現在のパターン(${e.s}目 × ${e.r}段)をSRテキストで保存しました${e.colors > 1 ? "（SRテキストは2値のため、地色以外の目はすべて X）" : ""}`);
  };
  /* パタコン(PC10)の書き出しは常に ZIP 1本(SRDS.zip / .DAT は1ファイル=1パターン)。 */
  /* 1パターンだけを SRDS 一式として書き出す。パターン番号は元の位置に関わらず 00000 へ振り直し、
     データ1件の SRDS.IDX と組にする。配置は全件書き出しと同じで .DAT は D000 の下に入る。 */
  const exportPC10Single = (entry) => {
    zipSRDS([
      [buildSRDSIdx(1), "SRDS.IDX"],
      [buildPC10(entry, 0), `${srName(0)}.DAT`],
    ]);
    say(`${SRDS_ZIP_NAME} を書き出しました(SRDS.IDX + ${srdsDir(0)}/${srName(0)}.DAT${entry.colors > 1 ? ` / 地色+${entry.colors}色=${passCount(entry.colors)}パス展開` : ""})`);
  };
  /* SRDS一式(索引 + 全パターン)を組み立てる。SRDS.IDX を先頭に、パターン名(SR+5桁)の .DAT を続ける。 */
  const srdsFiles = () => {
    const entries = library.length ? library : [docEntry()];
    return [
      [buildSRDSIdx(entries.length), "SRDS.IDX"],
      ...entries.map((e, i) => [buildPC10(e, i), `${srName(i)}.DAT`]),
    ];
  };
  /* 一式をZIP1本で受け取る。ブラウザの連続ダウンロード抑止を受けないため確実。
     .DAT は100件ごとのディレクトリ Dnnn へ振り分ける(nnn = 通し番号 ÷ 100 の整数部)。
     索引 SRDS.IDX はディレクトリを持たず、ZIPの直下に置く。 */
  /* 索引と .DAT をカード上の配置どおりに並べてZIP化する。
     SRDS.IDX はZIP直下、.DAT は100件ごとの Dnnn/ 配下に置く。
     ZIP のファイル名は SRDS_ZIP_NAME("SRDS.zip")に固定する。中の名前は SRDS.IDX のまま。 */
  const zipSRDS = (files) => {
    const placed = files.map(([bin, name], i) =>
      i === 0 ? [bin, name] : [bin, `${srdsDir(i - 1)}/${name}`]);
    downloadBlob(new Blob([buildZip(placed)], { type: "application/zip" }), SRDS_ZIP_NAME);
    return placed;
  };
  const exportPC10Zip = () => {
    const placed = zipSRDS(srdsFiles());
    const dirs = new Set(placed.slice(1).map(([, n]) => n.split("/")[0]));
    say(`${SRDS_ZIP_NAME} を書き出しました(${placed.length}ファイル / ${[...dirs].join(", ")})`);
  };
  /* 現在編集中のパターンだけを SR00000.DAT として、データ1件の SRDS.IDX と一緒にZIP化する。
     パターン集の内容には影響されない。配置は全件書き出しと同じで、.DAT は D000 の下に入る。 */
  const exportPC10Current = () => exportPC10Single(docEntry());
  const loadEntry = (entry, label) => {
    commitLoaded((d) => {
      /* エントリは色番号グリッドとパレットを持つ。色番号は動かさず、スロットは8に整える */
      const pal = padPalette(entry.palette && entry.palette.length >= 2 ? entry.palette : d.palette);
      const g = cloneGrid(entry.grid);
      const pc = (entry.passControl || []).map((a) => (a ? a.slice() : a));
      const ctrl = Array.from({ length: entry.r }, (_, r) => (entry.control && entry.control[r]) || 0);
      return { ...d, stitches: entry.s, rows: entry.r, palette: pal, grid: g, control: ctrl, passControl: pc, colors: clamp(entry.colors || 1, 1, MAX_COLOR_NO) };
    });
    setSInput(String(entry.s)); setRInput(String(entry.r));
    setSelection(null); setGhost(null);
    say(`${label} を読み込みました`);
  };
  /* 編集モードでのパターン集の「コピー」。パターンをクリップボードへ写し、そのまま配置(ゴースト)にする。
     ドラッグで位置を決め、「確定」(Enter)で貼る。目数・段数の外(右端の右・最上段の上)へはみ出して置いたときは、
     確定時に警告して目数・段数を広げる(confirmGhost)。色は色番号のまま貼り、表示色は貼り先のパレットに従う。
     制御4bitは写さない(図案だけ)。初期位置は画面の中央付近で、左端・最下段の外へは出さない
     (パターンのほうが大きいときは、右と上へはみ出す位置に置く)。 */
  const copyEntryToGhost = (entry, label) => {
    /* コピー元の色数は、エントリの色数と図案で使っている最大の色番号の大きいほう(書き出しと同じ決め方) */
    const ec = clamp(Math.max(entry.colors || 1, maxColorNo(entry.grid)), 1, MAX_COLOR_NO);
    const dc = clamp(doc.colors || 1, 1, MAX_COLOR_NO);
    if (ec !== dc) { warn(colorMismatchMsg(label, ec, dc, "copy")); return; }
    const w = entry.s, h = entry.r;
    const cells = Array.from({ length: h }, (_, r) => {
      const row = new Uint8Array(w);
      const src = entry.grid && entry.grid[r];
      if (src) for (let c = 0; c < w; c++) row[c] = src[c] || 0;
      return row;
    });
    /* 色数と名前も持たせ、ペースト・確定の時点でも色数の一致を確かめる */
    setClipboard({ w, h, cells: cloneGrid(cells), colors: ec, label });
    const sc = scrollRef.current;
    let x = 0, y = R - h;
    if (sc) {
      x = Math.round((sc.scrollLeft + sc.clientWidth / 2 - M.left) / cell - w / 2);
      y = Math.round((sc.scrollTop + sc.clientHeight / 2 - ghostOY - M.top) / cell - h / 2);
    }
    x = clamp(x, 0, Math.max(0, S - w));
    y = h <= R ? clamp(y, 0, R - h) : R - h;
    setSelection(null);
    revealGhostRef.current = true;
    setGhost(fitGhost({ x, y, w, h, cells, colors: ec, label }));
    say(`${label}（${w}目×${h}段）をコピーしました。ドラッグで位置を決めて「確定」で貼り付けます`
      + (w > S || h > R ? "（はみ出すぶんは確定時に広げられます）" : ""));
  };
  /* 取り込んだエントリをパターン集に追加し、1件なら即読込・複数ならピッカー窓を開く共通処理。
     MAX_LIB を超えるぶんは保存できないので、切り捨てる前に必ずダイアログで知らせる。 */
  const openImportedEntries = (entries, srcNote = "", onAdded) => {
    const base = library.length;
    const free = Math.max(0, MAX_LIB - base);
    if (free === 0) {
      warn(`パターン集が上限の ${MAX_LIB} 件に達しています。\n読み込んだ ${entries.length} 件は保存できません。\n不要なパターンを削除してから読み込んでください。`);
      return;
    }
    if (entries.length > free) {
      const over = entries.length - free;
      ask(
        `パターン集は ${MAX_LIB} 件までです。\n`
        + `現在 ${base} 件 ＋ 読み込み ${entries.length} 件 = ${base + entries.length} 件\n`
        + `先頭の ${free} 件だけを追加し、残り ${over} 件は保存できません。\n読み込みますか?`,
        () => addImportedEntries(entries.slice(0, free), srcNote, base, over, onAdded)
      );
      return;
    }
    addImportedEntries(entries, srcNote, base, 0, onAdded);
  };
  const addImportedEntries = (entries, srcNote, base, over, onAdded) => {
    setLibrary((l) => [...l, ...entries]);
    setLibDirty(true);                           // パターン集が変わった → 保存を促す
    if (onAdded) onAdded();
    if (entries.length === 1) {
      loadEntry(entries[0], srName(base));
    } else {
      /* 複数パターンのときは専用フローティングウィンドウを開き、その中で選んで読み込ませる */
      setPickerNew({ from: base, to: base + entries.length });
      setPickerOpen(true);
      say(`${srcNote}${entries.length}パターンを読み込みました。一覧から選んで開けます`);
    }
    if (over) setTimeout(() => say(`上限 ${MAX_LIB} 件を超える ${over} 件は保存していません`), 2200);
  };
  const importSRText = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const entries = parseSRText(reader.result);
      if (!entries.length) { say("SR形式のパターンが見つかりませんでした"); return; }
      openImportedEntries(entries);
    };
    reader.readAsText(f);
    e.target.value = "";
  };
  /* ---- パターン集ファイル(全データ・JSON) ---- */
  const libStamp = () => {
    const t = new Date(), z = (v) => String(v).padStart(2, "0");
    return `${t.getFullYear()}${z(t.getMonth() + 1)}${z(t.getDate())}-${z(t.getHours())}${z(t.getMinutes())}`;
  };
  /* 保存名を整える。前後の空白を除き、ファイル名に使えない文字を「_」に、末尾の . と空白を除き、
     拡張子を .json にそろえる。空なら null。 */
  const libFileName = (raw) => {
    const t = String(raw || "").trim().replace(/\.json$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
    return t ? t + ".json" : null;
  };
  /* パターン集の保存。まず保存名を尋ねる。候補は、パターン集に結びついたファイル名(読み込んだ・保存した名前)が
     あればそれ、無ければ knit-library-年月日-時分.json。 */
  const exportLibrary = () => {
    if (!library.length) {
      warn("パターン集にパターンがありません。\nパターンを読み込むか「現在のパターンを追加」で登録してから保存してください。");
      return;
    }
    setSaveBox({ name: libName || `knit-library-${libStamp()}.json`, memo: libMemo, error: "" });
  };
  /* 保存名ダイアログを開いたら入力欄に移り、拡張子の手前までを選択して打ち替えやすくする */
  const saveBoxOpen = !!saveBox;
  useEffect(() => {
    const el = saveNameRef.current;
    if (!saveBoxOpen || !el) return;
    el.focus();
    const v = el.value, k = /\.json$/i.test(v) ? v.length - 5 : v.length;
    try { el.setSelectionRange(0, k); } catch { /* 選択できない環境では何もしない */ }
    /* Esc はどこにフォーカスがあっても閉じる(ボタンを押すとフォーカスが入力欄から外れるブラウザがあるため) */
    const onKey = (e) => { if (e.key === "Escape") setSaveBox(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveBoxOpen]);
  /* 保存名ダイアログの「保存」。書き出す前に文字列を読み戻し、全件が元と一致することを確かめてから
     ダウンロードする(一致しなければ保存しない)。ダウンロードはこのクリックの処理中に発行する。 */
  const confirmSaveLibrary = () => {
    if (!saveBox) return;
    const name = libFileName(saveBox.name);
    const retry = (error) => { setSaveBox((b) => ({ ...b, error })); if (saveNameRef.current) saveNameRef.current.focus(); };
    if (!name) { retry("ファイル名を入力してください"); return; }
    if (name.length > 105) { retry("ファイル名は100文字までにしてください"); return; }
    const list = library, memo = libNormMemo(saveBox.memo);
    const text = libraryToJSON(list, new Date().toISOString(), memo);
    let back = null;
    try { back = parseLibraryJSON(text); } catch { back = null; }
    const same = !!back && back.entries.length === list.length && !back.skipped.length && !back.fixed.length
      && !back.crcNg.length && !back.noCrc.length && back.memo === memo
      && list.every((e, i) => libSame(e, back.entries[i]));
    if (!same) {
      setSaveBox(null);
      warn("保存前の読み戻し検査で、元のパターン集と一致しない内容がありました。\nファイルは保存していません。");
      return;
    }
    downloadBlob(new Blob([text], { type: "application/json" }), name);
    const tidied = name.slice(0, -5) !== String(saveBox.name).trim().replace(/\.json$/i, "");
    setSaveBox(null);
    setLibName(name);
    setLibMemo(memo);
    setLibDirty(false);
    say(`パターン集 ${list.length}件を ${name} に保存しました（読み戻し検査済み${memo ? "・メモあり" : ""}${tidied ? "・使えない文字を整えました" : ""}）`);
  };
  /* 読み込み結果の要確認事項 */
  const libIssues = (res) => {
    const t = [], at = (a) => `ファイルの${a[0] + 1}件目${a.length > 1 ? "など" : ""}`;
    if (res.skipped.length) t.push(`${res.skipped.length}件は内容が読めないため読み込みません（${at(res.skipped)}）`);
    if (res.crcNg.length) t.push(`${res.crcNg.length}件はチェックサムが一致しません。ファイルが編集されたか壊れています（${at(res.crcNg)}）`);
    if (res.fixed.length) t.push(`${res.fixed.length}件は範囲外や欠けた値を補正して読み込みます（${at(res.fixed)}）`);
    if (res.noCrc.length) t.push(`${res.noCrc.length}件はチェックサムが無いため照合できません`);
    const total = res.entries.length + res.skipped.length;
    if (Number.isInteger(res.count) && res.count !== total) t.push(`ファイルの件数表示（${res.count}件）と実際の件数（${total}件）が違います`);
    return t;
  };
  /* パターン集をファイルの内容で置き換える。並びは保存したときと同じなので、パターン番号もそのまま戻る。 */
  const replaceLibrary = (entries, note, wasEmpty, fileName, memo) => {
    const list = entries.slice(0, MAX_LIB);
    setLibrary(list);
    setLibDirty(false);                          // ファイルの内容そのもの(保存済み)
    setLibName(fileName || "");
    setLibMemo(libNormMemo(memo));
    if (list.length === 1) loadEntry(list[0], srName(0));
    else { setPickerNew(null); setPickerOpen(true); }
    say(`パターン集を ${list.length}件${wasEmpty ? "読み込みました" : "で置き換えました"}${note}`);
  };
  /* パターン集ファイルの文字列を検査し、今のパターン集が空ならそのまま、空でなければ
     「置き換える / 後ろに追加 / キャンセル」を選んでもらって取り込む。 */
  const openLibraryText = (text, fileName) => {
    let res;
    try { res = parseLibraryJSON(text); }
    catch (err) { warn(`パターン集を読み込めませんでした。\n${err.message}`); return; }
    const n = res.entries.length;
    if (!n) {
      warn(`パターン集ファイルに読み込めるパターンがありません。${res.skipped.length ? `\n${res.skipped.length}件は内容が読めませんでした。` : ""}`);
      return;
    }
    const issues = libIssues(res);
    const note = issues.length ? "（要確認の項目あり）" : "（チェックサム全件一致）";
    const head = `${fileName}（v${res.version}${res.app ? `・${res.app} で保存` : ""}）\n${n}件${res.memo ? "・メモあり" : ""}${issues.length ? "\n" + issues.map((t) => "※" + t).join("\n") : "（チェックサム全件一致）"}`
      + (n > MAX_LIB ? `\n上限 ${MAX_LIB} 件を超える ${n - MAX_LIB} 件は読み込みません。` : "");
    if (!library.length) {
      if (issues.length) ask(`${head}\n\n読み込みますか?`, () => replaceLibrary(res.entries, note, true, fileName, res.memo));
      else replaceLibrary(res.entries, note, true, fileName, res.memo);
      return;
    }
    setConfirmBox({
      msg: `${head}\n\n今のパターン集は ${library.length} 件です。\n`
        + `・置き換える: 今のパターン集を消し、保存したときと同じ番号で復元します（元に戻せません）\n`
        + `・後ろに追加: ${srName(library.length)} から後ろへ追加します`,
      okLabel: "置き換える", onOk: () => replaceLibrary(res.entries, note, false, fileName, res.memo),
      /* 追加では、パターン集にまだ名前・メモが無いときだけこのファイルのものを結びつける
         (すでにあれば追加先のものを保つ。メモを勝手に書き換えないため) */
      altLabel: "後ろに追加", onAlt: () => openImportedEntries(res.entries, "パターン集ファイルから",
        () => { setLibName((nm) => nm || fileName); setLibMemo((m) => m || res.memo); }),
    });
  };
  const importLibrary = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => openLibraryText(reader.result, f.name);
    reader.onerror = () => warn("ファイルを読み取れませんでした");
    reader.readAsText(f);
    e.target.value = "";
  };
  /* 色数フィールドは多色なのに、選針データがパス展開として成り立たず2色(1パス)で読んだパターンの知らせ */
  const fallbackNote = (fb) => `※${fb.length}件は色数ヘッダが${fb[0].passFallback}パスでしたが、パス展開として成り立たないため2色(1パス)で読み込みました`;
  /* U-BOXメモリカードのバイナリ読み込み(テキストではなくArrayBufferとして読む) */
  const importUBox = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = parseUBox(reader.result);
      if (!res.magic) { say("U-BOX形式(先頭SR)のデータではないようです"); return; }
      if (!res.entries.length) { say("U-BOXデータからパターンを取得できませんでした"); return; }
      openImportedEntries(res.entries, "U-BOXから");
      const mc = res.entries.find((x) => x.colors > 1);
      if (res.entries.length === 1 && mc) setTimeout(() => say(`地色+${mc.colors}色 × ${mc.r}デザイン段として読み込みました`), 2200);
      if (res.truncated) setTimeout(() => say("※データが途中で終わっているパターンがありました"), 2700);
      const fb = res.entries.filter((x) => x.passFallback);
      if (fb.length) setTimeout(() => say(fallbackNote(fb)), 3200);
    };
    reader.readAsArrayBuffer(f);
    e.target.value = "";
  };
  /* PC10(パタコン) .DAT の読み込み。複数ファイル選択可。多色(Nパス展開)は色数に従って自動で畳み込む */
  const importPC10 = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const got = new Array(files.length).fill(null);
    let done = 0, bad = 0, cut = false;
    const finish = () => {
      const list = got.filter(Boolean);
      if (!list.length) { say("PC10形式(.DAT)のパターンを読み取れませんでした"); return; }
      const multi = list.find((x) => x.colors > 1);
      openImportedEntries(list, "PC10(.DAT)から");
      if (list.length === 1 && multi) setTimeout(() => say(`地色+${multi.colors}色 × ${multi.r}デザイン段として読み込みました`), 2200);
      if (bad) setTimeout(() => say(`${bad}件は .DAT として読み取れませんでした`), 2700);
      if (cut) setTimeout(() => say("※データが途中で終わっているパターンがありました"), 3200);
      const fb = list.filter((x) => x.passFallback);
      if (fb.length) setTimeout(() => say(fallbackNote(fb)), 3700);
    };
    files.forEach((f, i) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = parsePC10(reader.result);
        if (!res.magic || !res.entry) bad++; else { got[i] = res.entry; if (res.entry.truncated) cut = true; }
        if (++done === files.length) finish();
      };
      reader.onerror = () => { bad++; if (++done === files.length) finish(); };
      reader.readAsArrayBuffer(f);
    });
  };
  const exportChartPNG = () => {
    /* セルは18px基準。ただしブラウザのcanvas上限(概ね16384px)を超えると toBlob が null を返すため、
       大きなパターン(最大240×1000)では自動で縮める。 */
    const CANVAS_MAX = 16000;
    const cs = clamp(Math.floor(Math.min(CANVAS_MAX / (S + 3), CANVAS_MAX / (R + 3))), 3, 18);
    const L = Math.round(cs * 1.9), T = Math.round(cs * 0.6), B = Math.round(cs * 1.5), Rt = Math.round(cs * 0.6);
    const cv = document.createElement("canvas");
    cv.width = L + S * cs + Rt; cv.height = T + R * cs + B;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
    for (let r = 0; r < R; r++) for (let c = 0; c < S; c++) {
      ctx.fillStyle = doc.palette[doc.grid[r][c]];
      ctx.fillRect(L + c * cs, T + r * cs, cs, cs);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let c = 0; c <= S; c++) { ctx.moveTo(L + c * cs + 0.5, T); ctx.lineTo(L + c * cs + 0.5, T + R * cs); }
    for (let r = 0; r <= R; r++) { ctx.moveTo(L, T + r * cs + 0.5); ctx.lineTo(L + S * cs, T + r * cs + 0.5); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let c = 0; c <= S; c++) if (c % 5 === 0) { ctx.moveTo(L + c * cs + 0.5, T); ctx.lineTo(L + c * cs + 0.5, T + R * cs); }
    for (let r = 0; r <= R; r++) if ((R - r) % 5 === 0) { ctx.moveTo(L, T + r * cs + 0.5); ctx.lineTo(L + S * cs, T + r * cs + 0.5); }
    ctx.stroke();
    ctx.fillStyle = "#333"; ctx.font = `${Math.max(6, Math.round(cs * 0.56))}px sans-serif`;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let r = 0; r < R; r++) { const n = R - r; if (n === 1 || n % 5 === 0) ctx.fillText(String(n), L - Math.round(cs * 0.25), T + r * cs + cs / 2); }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let c = 0; c < S; c++) { const n = c + 1; if (n === 1 || n % 5 === 0) ctx.fillText(String(n), L + c * cs + cs / 2, T + R * cs + Math.round(cs * 0.35)); }
    cv.toBlob((b) => b ? downloadBlob(b, "knit-chart.png") : say("画像が大きすぎて書き出せませんでした"));
  };
  const exportMachinePNG = () => {
    const cv = document.createElement("canvas");
    cv.width = S; cv.height = R;
    const ctx = cv.getContext("2d");
    for (let r = 0; r < R; r++) for (let c = 0; c < S; c++) {
      ctx.fillStyle = doc.palette[doc.grid[r][c]];
      ctx.fillRect(c, r, 1, 1);
    }
    cv.toBlob((b) => b ? downloadBlob(b, `knit-machine-${S}x${R}.png`) : say("画像を書き出せませんでした"));
    say("1目=1pxのPNGを書き出しました(AYAB / img2track用)");
  };

  /* ============================== キーボード ============================== */
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if (!editMode) { return; } /* 表示モードでは以降の編集系ショートカットを無効化 */
      else if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); doCopy(); }
      else if (mod && e.key.toLowerCase() === "x") { e.preventDefault(); doCut(); }
      else if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); doPaste(); }
      else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selectAll(); }
      else if (e.key === "Delete" || e.key === "Backspace") { if (selection) { e.preventDefault(); doDelete(); } }
      else if (e.key === "Escape") { if (gridMenu) setGridMenu(null); else if (ghost) cancelGhost(); else setSelection(null); }
      else if (selection && !ghost) {
        if (e.key === "h") doFlipSel("h");
        else if (e.key === "v") doFlipSel("v");
        else if (e.key === "r") doRotSel();
      } else if (ghost) {
        if (e.key === "h") ghostTransform(flipCellsH);
        else if (e.key === "v") ghostTransform(flipCellsV);
        else if (e.key === "r") ghostTransform(rotCellsCW);
        /* 配置中の Enter は確定だけを行う。直前に押したボタンにフォーカスが残っていると、既定の動作で
           そのボタンも押されてしまう(→+ を押してから Enter で1目余分に増えるなど)ので、既定の動作を止める */
        else if (e.key === "Enter") { e.preventDefault(); confirmGhost(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, doCopy, doCut, doPaste, selectAll, selection, ghost, gridMenu, editMode, doDelete, doFlipSel, doRotSel, ghostTransform, confirmGhost, cancelGhost]);

  /* ============================== palette drag / long-press ============================== */
  const gridPaneRef = useRef(null);
  const palDragStart = (e) => {
    if (e.target.closest("button")) return;
    const pane = gridPaneRef.current.getBoundingClientRect();
    const panel = e.currentTarget.parentElement.getBoundingClientRect();
    const ox = e.clientX - panel.left, oy = e.clientY - panel.top;
    const move = (ev) => setPalPos({
      x: clamp(ev.clientX - pane.left - ox, 0, pane.width - 70),
      y: clamp(ev.clientY - pane.top - oy, 0, pane.height - 40),
    });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /* 選択・配置パレットのドラッグ移動 */
  const editBarDragStart = (e) => {
    if (e.target.closest("button")) return;
    const pane = gridPaneRef.current.getBoundingClientRect();
    const panel = e.currentTarget.parentElement.getBoundingClientRect();
    const ox = e.clientX - panel.left, oy = e.clientY - panel.top;
    const move = (ev) => setEditBarPos({
      x: clamp(ev.clientX - pane.left - ox, 0, pane.width - 70),
      y: clamp(ev.clientY - pane.top - oy, 0, pane.height - 40),
    });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /* プレビューウィンドウのドラッグ移動 */
  const pvDragStart = (e) => {
    if (e.target.closest("button")) return;
    const pane = gridPaneRef.current.getBoundingClientRect();
    const panel = e.currentTarget.parentElement.getBoundingClientRect();
    const ox = e.clientX - panel.left, oy = e.clientY - panel.top;
    const move = (ev) => setPvBox((b) => ({
      ...b,
      x: clamp(ev.clientX - pane.left - ox, 0, pane.width - 90),
      y: clamp(ev.clientY - pane.top - oy, 0, pane.height - 36),
    }));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /* プレビューウィンドウのリサイズ(右下ハンドル) */
  const pvResizeStart = (e) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const sw = pvBox.w, sh = pvBox.h;
    const pane = gridPaneRef.current.getBoundingClientRect();
    const move = (ev) => setPvBox((b) => ({
      ...b,
      w: clamp(sw + ev.clientX - sx, 170, pane.width - b.x - 4),
      h: clamp(sh + ev.clientY - sy, 150, pane.height - b.y - 4),
    }));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /* パターン集ピッカーのドラッグ移動(プレビュー窓と同方式) */
  const pickerDragStart = (e) => {
    if (e.target.closest("button")) return;
    const pane = gridPaneRef.current.getBoundingClientRect();
    const panel = e.currentTarget.parentElement.getBoundingClientRect();
    const ox = e.clientX - panel.left, oy = e.clientY - panel.top;
    const move = (ev) => setPickerBox((b) => ({
      ...b,
      x: clamp(ev.clientX - pane.left - ox, 0, pane.width - 90),
      y: clamp(ev.clientY - pane.top - oy, 0, pane.height - 36),
    }));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /* パターン集ピッカーのリサイズ(右下ハンドル) */
  const pickerResizeStart = (e) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const sw = pickerBox.w, sh = pickerBox.h;
    const pane = gridPaneRef.current.getBoundingClientRect();
    const move = (ev) => setPickerBox((b) => ({
      ...b,
      w: clamp(sw + ev.clientX - sx, 220, pane.width - b.x - 4),
      h: clamp(sh + ev.clientY - sy, 180, pane.height - b.y - 4),
    }));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const lpTimer = useRef(null), lpFired = useRef(false);
  /* スウォッチの長押し: その色番号を選び、パレット下部のカラー変更バーを開く。
     一括置換と地色戻しはバーの中のボタンから行う(右クリックでは従来のメニューも出る)。 */
  const openColorBar = (i) => {
    /* 色数の外の番号は選べない(短タップと同じ扱い)。選んでも選択が色数の上限へ戻されるため、
       バーの見出しと押したスウォッチが食い違ってしまう。 */
    if (i > clamp(doc.colors || 1, 1, MAX_COLOR_NO)) { say(`色${i} は色数を ${i + 1}色 以上にすると使えます`); return; }
    setSelColor(i); setPalMin(false); setColorBarOpen(true); setSwatchMenu(null); endColorSession();
    setTimeout(() => { try { colorInputRef.current && colorInputRef.current.focus(); } catch (_) {} }, 0);
  };
  /* 長押しの判定はペン・指・マウスで同じにする。
     ・押した瞬間にポインタをキャプチャし、押したまま少しぶれてスウォッチの外へ出ても取り消さない。
       取り消すのは 10px を超えて動いたときだけ(マウスはホバーで外れたときも取り消す)。
     ・ペン・指でブラウザや OS がジェスチャとして横取りした(pointercancel)ときも、動いていなければ長押しを続ける。
     ・ペン・指の長押しで OS が右クリック(contextmenu)を出したときは、メニューではなく長押しと同じくカラー変更バーを開く。
     以前はペンで長押しすると、ペン先のぶれで pointerleave が起きたり、ペンのジェスチャで pointercancel → pointerleave が
     起きたりして長押しが取り消され、カラー変更バーが開かなかった(指はブラウザが暗黙にキャプチャするので起きなかった)。 */
  const lpInfo = useRef(null);                     // {i, x, y, type, t} 直前に押したスウォッチ
  const startLP = (i) => (e) => {
    lpFired.current = false;
    clearTimeout(lpTimer.current);
    lpInfo.current = { i, x: e.clientX, y: e.clientY, type: e.pointerType || "mouse", t: Date.now() };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    lpTimer.current = setTimeout(() => { lpTimer.current = null; lpFired.current = true; openColorBar(i); }, LONGPRESS_MS);
  };
  const clearLP = () => { clearTimeout(lpTimer.current); lpTimer.current = null; };
  const moveLP = (e) => {
    const st = lpInfo.current;
    if (st && lpTimer.current && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 10) clearLP();
  };
  const leaveLP = (e) => { if ((e.pointerType || "mouse") === "mouse") clearLP(); };
  /* ペン・指の長押しから来た contextmenu か(直前にこのスウォッチをペン・指で押している) */
  const lpContext = (i) => {
    const st = lpInfo.current;
    return !!st && st.i === i && st.type !== "mouse" && Date.now() - st.t < 3000;
  };
  /* カラー変更バーの「適用」(テキスト入力の Enter も同じ)。色が確定したらバーを閉じる。
     不正な値のときは setSlotColor が false を返すので、直せるよう開いたままにする。 */
  const applyHex = () => {
    if (!setSlotColor(selColor, hexDraft, false)) return;
    setHexDraft(normHex(hexDraft));
    endColorSession();
    setColorBarOpen(false);
  };
  const changeTool = (t) => {
    setTool(t);
    if (t !== "select") setSelection(null);
    if (t === "pen") say("ペン：タッチペン・マウスは1タップ、指はダブルタップでマーク（長押しで地色に戻す）");
  };

  /* 鉛筆ボタン: 表示⇄編集モードのトグル。表示モードに戻るときは編集中の状態を片付ける。
     編集開始時は誤操作防止のため「選択ツール」にし、ペンを選んで初めて描画できるようにする。 */
  const toggleEditMode = () => {
    const next = !editMode;
    if (!next) { setSelection(null); setGhost(null); setDragShape(null); setMenuOpen(false); setGridMenu(null); }
    else { setTool("select"); say("編集モード：まずは選択のみ。ペン(鉛筆)を選ぶと描画できます（指はダブルタップ、タッチペン・マウスは1タップでマーク）。マスの長押しで地色(色0)に戻せます"); }
    setEditMode(next);
  };

  /* M5キャリコンからの切断要求(本体の A+C 長押し、rev.37): 編み機コントロールを閉じ、パターン表示モードへ戻る */
  const onKnitDeviceBye = () => {
    setKnitCtrl(false);
    if (editMode) { setSelection(null); setGhost(null); setDragShape(null); setMenuOpen(false); setGridMenu(null); setEditMode(false); }
    say("M5キャリコンから切断されました。パターン表示に戻りました", 6000);
  };

  /* グリッド右クリック → 段/目の挿入・削除メニュー(編集モードのみ) */
  const onGridContextMenu = (e) => {
    e.preventDefault();
    if (!editMode) return;
    const p = toCell(e);
    const col = clamp(p.x, 0, S - 1);
    const row = clamp(p.y, 0, R - 1);
    setGridMenu({ col, row, x: e.clientX, y: e.clientY });
  };

  const [swapSel, setSwapSel] = useState([0, 1]);
  /* 色の入れ替えはパレットと同じ番号表記(地色/色1..)で、色数の範囲内だけを選ばせる */
  const swapN = clamp(doc.colors || 1, 1, MAX_COLOR_NO);
  const swapA = Math.min(swapSel[0], swapN), swapB = Math.min(swapSel[1], swapN);
  const canUndo = undoRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;
  const checksOn = checks.colors || checks.float;

  /* ============================== render ============================== */
  /* 選択・配置の操作パレット。絶対配置の浮動ウィンドウなので、開閉しても選択の有無でも
     図案の位置は動かない。使えない操作は disabled にして淡く見せ、状態も見出しに出す。
     ツールバーの切り抜きアイコンで表示・非表示を切り替えられ、選択やゴーストが現れたときは
     必要になるので自動で開く。タイトル帯のドラッグで移動、□ で折りたたみ。 */
  const selOn = !!(selection && !ghost);
  const ghostOn = !!ghost;
  const editPalette = (
    <div className="absolute z-20 rounded-lg shadow-xl"
      style={{ ...(editBarPos ? { left: editBarPos.x, top: editBarPos.y } : (isNarrow ? { left: 12, top: 12 } : { left: 12, bottom: 12 })),
               background: "#262b34", border: "1px solid #3a4150", width: editBarMin ? 128 : 208 }}>
      <div className="flex items-center justify-between px-2 py-1 rounded-t-lg cursor-move" style={{ background: "#2f3542", touchAction: "none" }} onPointerDown={editBarDragStart}>
        <span className="text-xs font-medium whitespace-nowrap" style={{ color: "#c8cdd6" }}>選択・配置</span>
        <div className="flex items-center">
          <button onClick={() => setEditBarMin((m) => !m)} className="p-1 rounded hover:bg-slate-600" style={{ color: "#9aa2b0" }} title={editBarMin ? "展開" : "折りたたむ"}>
            {editBarMin ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
          </button>
          <button onClick={() => setEditBarOpen(false)} className="p-1 rounded hover:bg-slate-600" style={{ color: "#9aa2b0" }} title="閉じる(ツールバーの切り抜きアイコンで再表示)">
            <X size={12} />
          </button>
        </div>
      </div>
      {!editBarMin && (
        <div className="p-2 flex flex-col gap-1.5">
          {/* ---- 選択範囲の操作 ---- */}
          <div className="text-xs px-0.5 whitespace-nowrap" style={{ color: selOn ? "#f5a623" : "#77808f" }}>
            {selOn ? `選択 ${selection.w}×${selection.h}` : "選択なし"}
          </div>
          <div className="grid grid-cols-5 gap-1" style={{ opacity: selOn ? 1 : 0.5 }}>
            <TB onClick={doCopy} disabled={!selOn} title="コピー"><Copy size={14} /></TB>
            <TB onClick={doCut} disabled={!selOn} title="カット"><Scissors size={14} /></TB>
            <TB onClick={doPaste} disabled={!selOn || !clipboard} title="ペースト"><ClipboardPaste size={14} /></TB>
            <TB onClick={doFillSel} disabled={!selOn} title="選択範囲を塗る"><PaintBucket size={14} /></TB>
            <TB onClick={doDelete} disabled={!selOn} title="削除(地色に戻す)"><Trash2 size={14} /></TB>
            <TB onClick={() => doFlipSel("h")} disabled={!selOn} title="左右反転"><FlipHorizontal2 size={14} /></TB>
            <TB onClick={() => doFlipSel("v")} disabled={!selOn} title="上下反転"><FlipVertical2 size={14} /></TB>
            <TB onClick={doRotSel} disabled={!selOn} title="回転90°"><RotateCw size={14} /></TB>
            <TB onClick={doTile} disabled={!selOn} title="タイル複製"><LayoutGrid size={14} /></TB>
            <TB onClick={() => setSelection(null)} disabled={!selOn} title="選択解除"><X size={14} /></TB>
          </div>
          <span className="h-px" style={{ background: "#3a4150" }} />
          {/* ---- 段・目の追加と削除 ----
               選択範囲があればその段/目をまとめて対象にし、無いときは図案の端(段は最上段の上、
               目は右端の右)を1本ぶん対象にする。端側なら既存の段番号・目番号が動かない。
               削除は図案が失われるので必ず確認ダイアログを出す。追加は確認なし(元に戻せる)。 */}
          <div className="text-xs px-0.5 whitespace-nowrap" style={{ color: "#aab1bd" }}>
            段・目 <span style={{ color: "#77808f" }}>{selOn ? "対象:選択範囲" : "対象:図案の端"}</span>
          </div>
          {/* 段は上・下、目は左・右のどちらに足すかをボタンで選ぶ。選択範囲があればその隣に選択ぶん、無ければ図案の端に1本。
               削除(段−・目−)は従来どおり、選択範囲があればその段・目、無ければ最上段・右端の1本(確認あり) */}
          <div className="grid grid-cols-3 gap-1">
            <TB onClick={() => addLines("up")} disabled={knitBusy || R + (selOn ? selection.h : 1) > MAX_R}
              title={selOn ? `選択した段の上に${selection.h}段追加する` : "最上段の上に1段追加する"}>段↑+</TB>
            <TB onClick={() => addLines("down")} disabled={knitBusy || R + (selOn ? selection.h : 1) > MAX_R}
              title={selOn ? `選択した段の下に${selection.h}段追加する（上側の段番号は${selection.h}ずつ大きくなる）` : "最下段の下に1段追加する（既存の段番号は1つずつ大きくなる）"}>段↓+</TB>
            <TB onClick={palDelRows} disabled={knitBusy}
              title={selOn ? `選択した${selection.h}段を削除する（確認あり）` : "最上段の1段を削除する（確認あり）"}>段−</TB>
            <TB onClick={() => addLines("left")} disabled={knitBusy || S + (selOn ? selection.w : 1) > MAX_S}
              title={selOn ? `選択した目の左に${selection.w}目追加する（右側の目番号は${selection.w}ずつ大きくなる）` : "左端に1目追加する（既存の目番号は1つずつ大きくなる）"}>目←+</TB>
            <TB onClick={() => addLines("right")} disabled={knitBusy || S + (selOn ? selection.w : 1) > MAX_S}
              title={selOn ? `選択した目の右に${selection.w}目追加する` : "右端に1目追加する"}>目→+</TB>
            <TB onClick={palDelCols} disabled={knitBusy}
              title={selOn ? `選択した${selection.w}目を削除する（確認あり）` : "右端の1目を削除する（確認あり）"}>目−</TB>
          </div>
          <span className="h-px" style={{ background: "#3a4150" }} />
          {/* ---- 貼り付け(ゴースト)の操作 ---- */}
          <div className="text-xs px-0.5 whitespace-nowrap" style={{ color: ghostOn ? "#38bdf8" : "#77808f" }}>
            {ghostOn ? "配置中 — ドラッグで移動" : "配置なし"}
          </div>
          {/* はみ出し量(確定すると、このぶん目数・段数を広げるか尋ねる) */}
          {ghostOn && (ghost.x + ghost.w > S || ghost.y < 0) && (
            <div className="text-xs px-0.5" style={{ color: "#f5a623", lineHeight: 1.4 }}>
              はみ出し {[ghost.x + ghost.w > S && `目+${ghost.x + ghost.w - S}`, ghost.y < 0 && `段+${-ghost.y}`].filter(Boolean).join("・")}（確定で広げる）
            </div>
          )}
          <div className="grid grid-cols-3 gap-1" style={{ opacity: ghostOn ? 1 : 0.5 }}>
            <TB onClick={() => ghostTransform(flipCellsH)} disabled={!ghostOn} title="左右反転"><FlipHorizontal2 size={14} /></TB>
            <TB onClick={() => ghostTransform(flipCellsV)} disabled={!ghostOn} title="上下反転"><FlipVertical2 size={14} /></TB>
            <TB onClick={() => ghostTransform(rotCellsCW)} disabled={!ghostOn} title="回転90°"><RotateCw size={14} /></TB>
          </div>
          <div className="grid grid-cols-2 gap-1" style={{ opacity: ghostOn ? 1 : 0.5 }}>
            <button onClick={confirmGhost} disabled={!ghostOn} className="h-8 px-2 rounded-md flex items-center justify-center gap-1 text-xs font-medium disabled:opacity-40" style={{ background: "#34c07a", color: "#10241a" }}><Check size={14} />確定</button>
            <button onClick={cancelGhost} disabled={!ghostOn} className="h-8 px-2 rounded-md flex items-center justify-center gap-1 text-xs disabled:opacity-40" style={{ background: "#333a46", color: "#c8cdd6" }}><X size={14} />中止</button>
          </div>
        </div>
      )}
    </div>
  );

  /* モバイルの「全体プレビュー」タブ用ペイン */
  const previewPane = (
    <div className="flex-1 flex flex-col min-h-0 min-w-0" style={{ background: "#14161c" }}>
      <div className="flex items-center gap-1 px-2 py-1.5 shrink-0 flex-wrap">
        <TB active={previewKnit} onClick={() => setPreviewKnit((v) => !v)} title="編み目風の表示に切替">編み目</TB>
        <TB active={previewRepeat} onClick={() => setPreviewRepeat((v) => !v)} title="3×3リピート表示">3×3</TB>
        <div className="flex-1" />
        <span className="text-xs" style={{ color: "#5f6775" }}>{S}目 × {R}段</span>
      </div>
      <div ref={previewWrapRef} className="flex-1 min-h-0 flex items-center justify-center overflow-hidden p-2">
        <canvas ref={previewCanvasRef} style={{ borderRadius: 4, boxShadow: "0 2px 16px rgba(0,0,0,.5)" }} />
      </div>
    </div>
  );

  /* パターン集に結びついたファイル名の帯。パターン集ウィンドウ(PC・スマホ)とメニューの一覧の上部に出す。
     メモがあればファイル名の下に続けて出し、長いときはこの枠の中で縦にスクロールさせる
     (窓の高さを食わないよう、見える高さは4行ぶんまでにしている)。 */
  const libNameBar = (px) => (libName || libMemo) ? (
    <div className="shrink-0" style={{ background: "#232833", borderBottom: "1px solid #333a46" }}>
      {libName && (
        <div className={`flex items-center gap-1.5 ${px} py-1 text-xs`} style={{ color: "#d7dbe2" }} title={`読み込み・保存したファイル: ${libName}`}>
          <FileText size={12} style={{ color: "#f5a623", flexShrink: 0 }} />
          <span className="truncate">{libName}</span>
        </div>
      )}
      {libMemo && (
        <div className={`flex items-start gap-1.5 ${px} pb-1 text-xs`} style={{ color: "#a9b1bf" }} title="パターン集のメモ（「パターン集を保存」で編集できます）">
          <StickyNote size={12} style={{ color: "#8b93a1", flexShrink: 0, marginTop: 2 }} />
          <div className="flex-1 min-w-0 overflow-y-auto whitespace-pre-wrap break-words"
            style={{ maxHeight: "4.8em", lineHeight: 1.6, overscrollBehavior: "contain" }}>{libMemo}</div>
        </div>
      )}
    </div>
  ) : null;
  /* パターン集ピッカーの中身(サムネイル一覧)。デスクトップの窓とモバイルのモーダルで共用 */
  const pickerBody = (
    <div className="flex-1 min-h-0 overflow-auto p-2" style={{ display: "grid", gap: 8, alignContent: "start" }}>
      {library.length === 0 ? (
        <div className="text-xs text-center px-4 py-8" style={{ color: "#77808f", lineHeight: 1.7 }}>
          パターンがありません。<br />メニューの「パターン読み込み」または「現在のパターンを追加」で登録できます。
        </div>
      ) : (
        library.map((e, i) => {
          const isNew = pickerNew && i >= pickerNew.from && i < pickerNew.to;
          return (
            <div key={i} className="flex items-center gap-2 p-2 rounded" style={{ background: "#232833", border: isNew ? "1px solid #f5a623" : "1px solid #333a46" }}>
              <div className="shrink-0 flex items-center justify-center" style={{ width: 80, height: 80, background: "#151a21", borderRadius: 4, overflow: "hidden" }}>
                <SRThumb entry={e} max={76} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate" style={{ color: "#e6e9ee" }}>{srName(i)}{isNew && <span style={{ color: "#f5a623" }}> ・新規</span>}</div>
                <div className="text-xs mt-0.5" style={{ color: "#8a92a0" }}>{e.s}目 × {e.r}段</div>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                {/* 編集モードでは「読込」を「コピー」にし(図案の上に配置して貼る)、DAT と削除は使えなくする */}
                <button
                  disabled={knitBusy}
                  onClick={() => { if (editMode) copyEntryToGhost(e, srName(i)); else loadEntry(e, srName(i)); if (isNarrow) setPickerOpen(false); }}
                  className="h-8 px-3 rounded text-xs font-medium disabled:opacity-40"
                  title={knitBusy ? (editMode ? "転送中はコピーできません" : "転送中は読み込めません")
                    : (editMode ? "このパターンをコピーして図案の上に置く(ドラッグで位置を決めて「確定」で貼り付け)" : "このパターンを開く")}
                  style={{ background: "#f5a623", color: "#20242c" }}
                >{editMode ? "コピー" : "読込"}</button>
                <button
                  disabled={editMode}
                  onClick={() => exportPC10Single(e)}
                  className="h-7 px-3 rounded text-xs disabled:opacity-40"
                  style={{ background: "#333a46", color: "#c8cdd6" }}
                  title={editMode ? "編集モードでは使えません" : "このパターンをSRDS一式(SRDS.zip)で保存"}
                >DAT</button>
                <button
                  disabled={editMode}
                  onClick={() => deleteEntry(i)}
                  className="h-7 px-3 rounded text-xs disabled:opacity-40"
                  style={{ background: "#333a46", color: "#f87171" }}
                  title={editMode ? "編集モードでは使えません" : "このパターンをパターン集から削除"}
                >削除</button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  const editPane = (
    <div ref={gridPaneRef} className="flex-1 flex flex-col min-w-0 min-h-0 relative">
      <div className="flex-1 min-h-0 relative">
        <div ref={scrollRef} className="absolute inset-0 overflow-auto" style={{ background: PANE_BG }}>
          {/* 配置中は下に画面1枚ぶんの余白を足す。上の配置余白が増えたとき、必ずスクロールで打ち消して
               図案を画面上の同じ位置に保てるようにするため(スクロールできる量が足りないと図案が下へずれる) */}
          <div className="inline-block" style={{ padding: PAD, paddingBottom: ghost ? PAD + (scrollRef.current ? scrollRef.current.clientHeight : 0) : PAD }}>
            {/* 制御ビットのマス目の真上。どの層(地色/各パス)にマークを付けるかを選ぶ */}
            {editMode && (
              /* 横スクロールしても左の固定ペイン(制御マス)の真上に残るよう、左端に貼り付ける */
              /* 縦横どちらへスクロールしても、制御マスの真上に残す(長い図案で画面外へ流れないように) */
              <div style={{ paddingLeft: IDXW, marginBottom: 2, position: "sticky", top: 0, left: PAD, width: "fit-content", zIndex: 3, background: PANE_BG, paddingBottom: 2, borderRadius: 4 }}>
                {/* 2色は色1パスだけなので無効(固定)。多色は色1パス〜色(n−1)パス(最終の地色パスは出さない) */}
                <select
                  value={ctrlSel}
                  onChange={(e) => setCtrlTarget(+e.target.value)}
                  disabled={ctrlPassN < 2}
                  title={ctrlPassN < 2
                    ? "2色は1パスなので、制御ビット(ブザー・指示ビット)は色1パスに付けます(選ぶ必要はありません)"
                    : `ブザーと制御ビットを付ける色パスを選ぶ(色1〜色${ctrlMaxPass})。選んだパスだけを表示し、制御マスを押すとそのパスのビットが切り替わる。最終の色${ctrlPassN}パスは地色のパスなので選べない`}
                  className="h-6 rounded text-xs"
                  style={{ width: CTRLN * cell, minWidth: 116, background: padPalette(doc.palette)[passColorNo(ctrlSel, ctrlPassN)], border: "1px solid #333a46", color: fgOn(padPalette(doc.palette)[passColorNo(ctrlSel, ctrlPassN)]), opacity: 1 }}>
                  {Array.from({ length: ctrlMaxPass }, (_, i) => {
                    const pno = i + 1, ci = passColorNo(pno, ctrlPassN);
                    const bg = padPalette(doc.palette)[ci];
                    return (
                      <option key={i} value={pno} style={{ background: bg, color: fgOn(bg) }}>
                        {ctrlPassN < 2 ? "色1(レース・すべり目)" : `色${ci}パス(パス${pno})`}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
            <canvas
              ref={gridCanvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onContextMenu={onGridContextMenu}
              style={{ touchAction: editMode ? "none" : "pan-x pan-y", display: "block", borderRadius: 6, boxShadow: "0 2px 14px rgba(0,0,0,.45)" }}
            />
          </div>
        </div>
        {/* 横スクロールしても左端に残す: 段数インデックス + 制御マス + 制御記号 */}
        <canvas ref={leftPaneRef} className="absolute left-0 top-0 pointer-events-none"
          style={{ display: "none", boxShadow: "10px 0 12px -10px rgba(0,0,0,.75)" }} />
        {/* 縦スクロールしても上端に残す: 目数インデックス + 制御ビット凡例 */}
        <canvas ref={topPaneRef} className="absolute left-0 top-0 pointer-events-none"
          style={{ display: "none", boxShadow: "0 10px 12px -10px rgba(0,0,0,.75)" }} />
        {/* 左上の角(縦横ともスクロール中に必要) */}
        <canvas ref={cornerPaneRef} className="absolute left-0 top-0 pointer-events-none"
          style={{ display: "none", boxShadow: "10px 10px 12px -10px rgba(0,0,0,.75)" }} />
      </div>
      {/* フローティングプレビュー(デスクトップのみ) */}
      {!isNarrow && pvOpen && (
        <div className="absolute z-20 rounded-lg shadow-xl flex flex-col overflow-hidden" style={{ left: pvBox.x, top: pvBox.y, width: pvBox.w, height: pvMin ? "auto" : pvBox.h, background: "#1a1e26", border: "1px solid #3a4150" }}>
          <div className="flex items-center justify-between pl-2 pr-1 py-1 cursor-move shrink-0" style={{ background: "#2f3542", touchAction: "none" }} onPointerDown={pvDragStart}>
            <span className="text-xs font-medium whitespace-nowrap" style={{ color: "#c8cdd6" }}>全体プレビュー</span>
            <div className="flex items-center shrink-0">
              <button onClick={() => setPvMin((m) => !m)} className="p-1 rounded hover:bg-slate-600" style={{ color: "#9aa2b0" }} title={pvMin ? "展開" : "折りたたむ"}>
                {pvMin ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
              </button>
              <button onClick={() => setPvOpen(false)} className="p-1 rounded hover:bg-slate-600" style={{ color: "#9aa2b0" }} title="閉じる(ツールバーの目のアイコンで再表示)">
                <X size={12} />
              </button>
            </div>
          </div>
          {!pvMin && (
            <>
              <div className="flex items-center gap-1 px-1.5 py-1 shrink-0" style={{ borderBottom: "1px solid #2a2f38" }}>
                <TB active={previewKnit} onClick={() => setPreviewKnit((v) => !v)} title="編み目風の表示に切替">編み目</TB>
                <TB active={previewRepeat} onClick={() => setPreviewRepeat((v) => !v)} title="3×3リピート表示">3×3</TB>
                <div className="flex-1" />
                <span className="text-xs pr-1 whitespace-nowrap" style={{ color: "#5f6775" }}>{S}目×{R}段</span>
              </div>
              <div ref={previewWrapRef} className="flex-1 min-h-0 flex items-center justify-center overflow-hidden p-2">
                <canvas ref={previewCanvasRef} style={{ borderRadius: 4, boxShadow: "0 2px 16px rgba(0,0,0,.5)", maxWidth: "100%", maxHeight: "100%" }} />
              </div>
              <div onPointerDown={pvResizeStart} className="absolute" style={{ right: 0, bottom: 0, width: 20, height: 20, cursor: "nwse-resize", touchAction: "none" }} title="ドラッグでサイズ変更">
                <svg width="20" height="20" style={{ position: "absolute", right: 1, bottom: 1, opacity: 0.55, pointerEvents: "none" }}>
                  <path d="M17 7 L7 17 M17 12 L12 17" stroke="#9aa2b0" strokeWidth="1.5" fill="none" />
                </svg>
              </div>
            </>
          )}
        </div>
      )}
      {/* 選択・配置の操作パレット(編集モードのみ・絶対配置なので図案の位置に影響しない) */}
      {editMode && editBarOpen && editPalette}
      {/* フローティングパレット(編集モードのみ) */}
      {editMode && (
      <div className="absolute z-20 rounded-lg shadow-xl" style={{ ...(palPos ? { left: palPos.x, top: palPos.y } : { right: 12, bottom: 12 }), background: "#262b34", border: "1px solid #3a4150", width: palMin ? 96 : 184 }}>
        <div className="flex items-center justify-between px-2 py-1 rounded-t-lg cursor-move" style={{ background: "#2f3542", touchAction: "none" }} onPointerDown={palDragStart}>
          <span className="text-xs font-medium" style={{ color: "#c8cdd6" }}>パレット</span>
          <div className="flex items-center gap-1">
            {/* 長押しを知らなくても色を変えられるよう、開閉ボタンを見出しに常設する */}
            {!palMin && (
              <button onClick={() => setColorBarOpen((v) => !v)} className="px-1.5 rounded hover:bg-slate-600"
                title={colorBarOpen ? "カラー変更バーを隠す" : "カラー変更バーを出す(スウォッチ長押しでも開く)"}
                style={{ fontSize: 10, color: colorBarOpen ? "#f5a623" : "#9aa2b0", border: `1px solid ${colorBarOpen ? "#f5a623" : "#3a4150"}` }}>色</button>
            )}
            <button onClick={() => setPalMin((m) => !m)} className="p-1 rounded hover:bg-slate-600" style={{ color: "#9aa2b0" }}>
              {palMin ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
            </button>
          </div>
        </div>
        {!palMin && (
          <div className="p-2">
            {/* スロットは地色+色1..色7の8個で固定。色数を超える番号は選べない(色数で増やす)。
                選択中のスロットをもう一度押すとカラーピッカーが開き、任意の色に変えられる。 */}
            <div className="grid grid-cols-4 gap-1.5">
              {padPalette(doc.palette).map((hex, i) => {
                const off = i > clamp(doc.colors || 1, 1, MAX_COLOR_NO);   // 色数の外=まだ使えない色番号
                return (
                <button
                  key={i}
                  onClick={() => {
                    if (lpFired.current) { lpFired.current = false; return; }
                    if (off) { say(`色${i} は色数を ${i + 1}色 以上にすると使えます`); return; }
                    setSelColor(i); endColorSession();
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    /* ペン・指の長押しで OS が出した右クリックは、長押しとして扱う(カラー変更バーを開く) */
                    if (lpContext(i)) { clearLP(); if (!lpFired.current) { lpFired.current = true; openColorBar(i); } return; }
                    setSwatchMenu({ index: i, x: e.clientX, y: e.clientY, mode: "menu" });
                  }}
                  onPointerDown={startLP(i)}
                  onPointerMove={moveLP}
                  onPointerUp={clearLP}
                  onPointerLeave={leaveLP}
                  className="relative h-8 rounded"
                  title={i === 0 ? "地色(色0)＝消しゴム。この色で描くと図案が消える" : off ? `色${i}(色数の外)` : `色${i} = 第${i}パス`}
                  style={{ background: hex, opacity: off ? 0.28 : 1, border: i === 0 ? "1px dashed #7a8290" : "1px solid rgba(0,0,0,.35)", outline: selColor === i ? "2px solid #f5a623" : "none", outlineOffset: 1,
                    /* ペン・指の長押しをブラウザのジェスチャ(スクロール・文字選択・長押しメニュー)に取られないようにする */
                    touchAction: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}
                >
                  {selColor === i && <Check size={13} style={{ position: "absolute", inset: 0, margin: "auto", color: luminance(hex) > 0.6 ? "#222" : "#fff" }} />}
                  <span style={{ position: "absolute", right: 2, bottom: 0, fontSize: 9, lineHeight: "10px", color: luminance(hex) > 0.6 ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.7)" }}>{i}</span>
                </button>
                );
              })}
            </div>
            {/* 選択中の色番号の表示色を変えるカラー変更バー。スウォッチ長押しか見出しの「色」で開く。
                画面に出ている入力でしか色は選べない
                (display:none の input[type=color] は .click() してもピッカーが開かない)。 */}
            {colorBarOpen && (
            <div className="mt-2 pt-2" style={{ borderTop: "1px solid #333a46" }}>
              <div className="flex items-center justify-between mb-1" style={{ fontSize: 10, color: "#9aa2b0" }}>
                <span>{selColor === 0 ? "地色(色0)" : `色${selColor}`} の色</span>
                <button onClick={() => setColorBarOpen(false)} className="p-0.5 rounded hover:bg-slate-600" style={{ color: "#9aa2b0" }} title="カラー変更バーを閉じる"><X size={11} /></button>
              </div>
              <input
                ref={colorInputRef}
                type="color"
                value={padPalette(doc.palette)[selColor] || "#000000"}
                onChange={(e) => setSlotColor(selColor, e.target.value, true)}
                onBlur={endColorSession}
                className="w-full h-8 rounded"
                title="タップでカラーピッカーを開く"
                style={{ padding: 0, background: "transparent", border: "1px solid #3a4150", cursor: "pointer" }}
              />
              <div className="mt-1.5 flex gap-1">
                <input
                  type="text"
                  value={hexDraft}
                  spellCheck={false}
                  maxLength={7}
                  placeholder="#RRGGBB"
                  onChange={(e) => setHexDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") applyHex(); }}
                  className="flex-1 min-w-0 h-7 px-1.5 rounded"
                  style={{ fontSize: 11, background: "#1f242c", border: `1px solid ${normHex(hexDraft) ? "#3a4150" : "#a3462f"}`, color: "#e6e9ee" }}
                />
                <button
                  onClick={applyHex}
                  className="h-7 px-2 rounded shrink-0"
                  style={{ fontSize: 11, background: "#f5a623", color: "#1d1d1d" }}
                >適用</button>
              </div>
              {/* 色番号そのものへの操作。長押しメニューに置いていたものをバーの中へ移した */}
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                <button onClick={(e) => setSwatchMenu({ index: selColor, x: e.clientX, y: e.clientY, mode: "replace" })}
                  className="h-7 px-1 rounded" title="この色番号のマスを別の色番号へ置き換える"
                  style={{ fontSize: 10, background: "#333a46", color: "#c8cdd6" }}>一括置換…</button>
                <button onClick={() => clearColor(selColor)} disabled={selColor === 0}
                  className="h-7 px-1 rounded disabled:opacity-40" title={selColor === 0 ? "地色そのものは戻す対象がありません" : "この色番号のマスをすべて地色に戻す"}
                  style={{ fontSize: 10, background: "#333a46", color: "#f0a08a" }}>全マス地色に</button>
              </div>
              <div className="mt-1 text-center" style={{ fontSize: 10, color: "#5f6775" }}>1677万色から選べます</div>
            </div>
            )}
            <p className="mt-1 text-center" style={{ fontSize: 10, color: "#77808f" }}>消すときは地色(色0)を選ぶ。スウォッチ長押しでカラー変更バー／図案のマス長押しでそのマスを地色に</p>
          </div>
        )}
      </div>
      )}
      {/* パターン集ピッカー(デスクトップ・フローティング窓)。複数パターン読込時に開く */}
      {!isNarrow && pickerOpen && (
        <div className="absolute z-30 rounded-lg shadow-xl flex flex-col overflow-hidden" style={{ left: pickerBox.x, top: pickerBox.y, width: pickerBox.w, height: pickerBox.h, background: "#1a1e26", border: "1px solid #3a4150" }}>
          <div className="flex items-center justify-between pl-2 pr-1 py-1 cursor-move shrink-0" style={{ background: "#2f3542", touchAction: "none" }} onPointerDown={pickerDragStart}>
            <span className="text-xs font-medium whitespace-nowrap flex items-center gap-1" style={{ color: "#c8cdd6" }}>
              <Library size={12} /> パターン集({library.length}件)
            </span>
            <div className="flex items-center">
              <button disabled={libFull} onClick={addToLibrary} className="p-1 rounded hover:bg-slate-600 disabled:opacity-40" style={hintBtn(addHint, ADD_HINT, "#10241a")} title={addTitle}><BookPlus size={12} /></button>
              <button disabled={knitBusy} onClick={() => libInputRef.current.click()} className="p-1 rounded hover:bg-slate-600 disabled:opacity-40" style={{ color: "#9aa2b0" }} title="パターン集を読み込み(全データ・JSON)"><FolderOpen size={12} /></button>
              <button onClick={exportLibrary} className="p-1 rounded hover:bg-slate-600" style={hintBtn(saveHint, SAVE_HINT, "#fff")} title={saveTitle}><Save size={12} /></button>
              <button onClick={() => setPickerOpen(false)} className="p-1 rounded hover:bg-slate-600" style={{ color: "#9aa2b0" }} title="閉じる(ツールバーのアイコンで再表示)">
                <X size={12} />
              </button>
            </div>
          </div>
          {libNameBar("px-2")}
          {pickerBody}
          <div onPointerDown={pickerResizeStart} className="absolute" style={{ right: 0, bottom: 0, width: 20, height: 20, cursor: "nwse-resize", touchAction: "none" }} title="ドラッグでサイズ変更">
            <svg width="20" height="20" style={{ position: "absolute", right: 1, bottom: 1, opacity: 0.55, pointerEvents: "none" }}>
              <path d="M17 7 L7 17 M17 12 L12 17" stroke="#9aa2b0" strokeWidth="1.5" fill="none" />
            </svg>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="w-full flex flex-col select-none" style={{ height: "100vh", background: "#171a20", color: "#d7dbe2", fontFamily: "system-ui, sans-serif" }}>
      {/* ヘッダー */}
      <header className="flex items-center gap-2 px-3 py-2 border-b overflow-x-auto shrink-0" style={{ borderColor: "#2a2f38" }}>
        {/* アプリ名は白地に黒、その脇の版表示は黒地に白。どの版を開いているかがすぐ分かるようにする */}
        <h1 className="text-sm font-semibold tracking-wide whitespace-nowrap mr-1 flex items-center shrink-0"
          style={{ color: "#111", background: "#fff", borderRadius: 6, padding: "3px 4px 3px 9px" }}>
          <span style={{ color: "#e8801a", marginRight: 4 }}>❋</span>SRパタコン
          <span title={`SRパタコン ${APP_REV}（${APP_DATE}）／ファイル形式 v1〜v${FILE_VERSION} に対応`}
            style={{ marginLeft: 8, padding: "1px 7px", fontSize: 11, fontWeight: 600, letterSpacing: 0, color: "#fff", background: "#111", borderRadius: 4 }}>{APP_REV}</span>
        </h1>
        <label className="text-xs whitespace-nowrap" style={{ color: "#8b93a1" }}>目数</label>
        <input value={sInput} onChange={(e) => setSInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applySize()} inputMode="numeric" disabled={!editMode || knitBusy} className="w-14 h-8 rounded px-1 text-sm text-center disabled:opacity-40" style={{ background: "#232833", border: "1px solid #333a46", color: "#e6e9ee" }} />
        <label className="text-xs whitespace-nowrap" style={{ color: "#8b93a1" }}>段数</label>
        <input value={rInput} onChange={(e) => setRInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applySize()} inputMode="numeric" disabled={!editMode || knitBusy} className="w-14 h-8 rounded px-1 text-sm text-center disabled:opacity-40" style={{ background: "#232833", border: "1px solid #333a46", color: "#e6e9ee" }} />
        <label className="text-xs whitespace-nowrap" style={{ color: "#8b93a1" }}>色数</label>
        <select value={clamp(doc.colors || 1, 1, MAX_COLOR_NO) + 1} onChange={(e) => applyColorCount(+e.target.value)} disabled={!editMode || knitBusy}
          title="色数(地色を含む)。最小は2色=1パス。すべり目・スレッド・レースもここに入る。3色以上は色数ぶんのパスで、最後のパスが地色の柄"
          className="h-8 rounded px-1 text-xs disabled:opacity-40" style={{ background: "#232833", border: "1px solid #333a46", color: "#e6e9ee" }}>
          <option value={2}>2色(レース)／1パス</option>
          <option value={3}>3色／3パス</option>
          <option value={4}>4色／4パス</option>
          <option value={5}>5色／5パス</option>
          <option value={6}>6色／6パス</option>
          <option value={7}>7色／7パス</option>
          <option value={8}>8色／8パス</option>
        </select>
        {editMode && <select onChange={(e) => { if (!e.target.value) return; const [a, b] = e.target.value.split("x"); applyPreset(+a, +b); e.target.value = ""; }} className="h-8 rounded px-1 text-xs" style={{ background: "#232833", border: "1px solid #333a46", color: "#aab1bd" }}>
          <option value="">プリセット</option>
          <option value="24x60">パンチカード 24×60</option>
          <option value="40x50">モチーフ 40×50</option>
          <option value="60x150">創作カード 60×150</option>
          <option value="200x400">パタコン 200×400</option>
          <option value="240x1000">最大 240×1000</option>
        </select>}
        {/* 適用・新規はプリセットの右に置く(目数・段数・プリセットで決めた値をここで確定する) */}
        {editMode && <button onClick={applySize} disabled={knitBusy} className="h-8 px-3 rounded text-xs font-medium whitespace-nowrap disabled:opacity-40" style={{ background: "#f5a623", color: "#1d1d1d" }}>適用</button>}
        {editMode && <button onClick={startNew} disabled={knitBusy} title="今のパターンを消して、目数・段数の値で新しいパターンを始める" className="h-8 px-3 rounded text-xs font-medium whitespace-nowrap disabled:opacity-40" style={{ background: "#333a46", color: "#c8cdd6", border: "1px solid #444c5c" }}>新規</button>}
        <div className="flex-1" />
        {checksOn && warnCount > 0 && (
          <span className="flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap" style={{ background: "rgba(220,60,60,.15)", color: "#f28b8b" }}>
            <AlertTriangle size={12} />{warnCount}段に警告
          </span>
        )}
      </header>
      {/* ツールバー */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b overflow-x-auto shrink-0" style={{ borderColor: "#2a2f38", background: editMode ? "#241f14" : "#1b1f26" }}>
        <button onClick={() => setKnitCtrl(true)} title="編み機コントロール（WSでArduino編み機へ転送）"
          className="flex items-center gap-2 h-10 px-3.5 rounded-lg text-sm font-semibold shrink-0"
          style={{ background: knitCtrl ? "#2f6b4f" : "#173a2b", color: "#8ef0b6", border: "1px solid #2f6b4f" }}>
          <Wifi size={22} strokeWidth={2.4} /><span>編み機</span>
        </button>
        <span className="w-px h-6 mx-1 shrink-0" style={{ background: "#3a4150" }} />
        <TB active={editMode} onClick={toggleEditMode} title={editMode ? "編集モード中（クリックで表示モードに戻る）" : "編集モードにする（鉛筆）"}>
          <Pen size={15} /><span className="hidden md:inline">{editMode ? "編集中" : "編集"}</span>
        </TB>
        {editMode ? (
          <>
            {/* 編集モードアイコンとの間に余白を空け、元に戻す/やり直し → セル選択 → ペン の順に並べる */}
            <span className="w-px h-5 mx-2 shrink-0" style={{ background: "#3a4150" }} />
            <TB onClick={undo} disabled={!canUndo || knitBusy} title="元に戻す"><Undo2 size={15} /></TB>
            <TB onClick={redo} disabled={!canRedo || knitBusy} title="やり直し"><Redo2 size={15} /></TB>
            <span className="w-px h-5 mx-0.5 shrink-0" style={{ background: "#3a4150" }} />
            <TB active={tool === "select"} onClick={() => changeTool("select")} title="セル選択(範囲選択)"><BoxSelect size={15} /></TB>
            <TB active={tool === "pen"} onClick={() => changeTool("pen")} title="ペン(タッチペン・マウスは1タップ／指はダブルタップでマーク・長押しで地色)"><Pen size={15} /></TB>
            <TB active={tool === "fill"} onClick={() => changeTool("fill")} title="塗りつぶし"><PaintBucket size={15} /></TB>
            <TB active={tool === "line"} onClick={() => changeTool("line")} title="直線"><Slash size={15} /></TB>
            <TB active={tool === "rect"} onClick={() => changeTool("rect")} title="矩形"><Square size={15} /></TB>
            {tool === "rect" && <TB active={rectFilled} onClick={() => setRectFilled((v) => !v)} title="枠のみ/塗りつぶしの切替">塗り</TB>}
            <span className="w-px h-5 mx-0.5 shrink-0" style={{ background: "#3a4150" }} />
            <TB active={mirror} onClick={() => setMirror((v) => !v)} title="左右対称に描画(ミラー)"><FlipHorizontal size={15} /><span className="hidden md:inline">ミラー</span></TB>
          </>
        ) : (
          <span className="text-xs px-2 whitespace-nowrap" style={{ color: "#8b93a1" }}>表示モード — 鉛筆で編集開始</span>
        )}
        <span className="w-px h-5 mx-0.5 shrink-0" style={{ background: "#3a4150" }} />
        <TB onClick={() => setCellSize((z) => clamp(z - 3, 6, maxCell))} title="縮小"><ZoomOut size={15} /></TB>
        <span className="text-xs w-8 text-center shrink-0" style={{ color: "#8b93a1" }}>{cell}px</span>
        <TB onClick={() => setCellSize((z) => clamp(z + 3, 6, maxCell))} title="拡大"><ZoomIn size={15} /></TB>
        <div className="flex-1" />
        {/* パターン集: 追加 → 読み込み → 保存 → 表示 の順。全体表示(目)ボタンの左に置く */}
        <TB disabled={libFull} onClick={addToLibrary} title={addTitle} hint={addHint ? [ADD_HINT, "#10241a"] : null}><BookPlus size={15} /></TB>
        <TB disabled={knitBusy} onClick={() => libInputRef.current.click()} title="パターン集を読み込み(全データ・JSON)"><FolderOpen size={15} /></TB>
        <TB disabled={!library.length} onClick={exportLibrary} title={saveTitle} hint={saveHint ? [SAVE_HINT, "#fff"] : null}><Save size={15} /></TB>
        {library.length > 0 && <TB active={pickerOpen} onClick={() => setPickerOpen((v) => !v)} title="パターン集ウィンドウの表示/非表示"><Library size={15} /></TB>}
        {editMode && <TB active={editBarOpen} onClick={() => setEditBarOpen((v) => !v)} title="選択・配置パレットの表示/非表示"><Scissors size={15} /></TB>}
        {!isNarrow && <TB active={pvOpen} onClick={() => setPvOpen((v) => !v)} title="全体プレビューの表示/非表示"><Eye size={15} /></TB>}
        <TB active={menuOpen} onClick={() => setMenuOpen((v) => !v)} title="メニュー"><MoreHorizontal size={16} /></TB>
      </div>
      {/* モバイル用タブ */}
      {isNarrow && (
        <div className="flex border-b shrink-0" style={{ borderColor: "#2a2f38" }}>
          {[["edit", "パターン入力"], ["preview", "全体プレビュー"]].map(([t, label]) => (
            <button key={t} onClick={() => setMobileTab(t)} className="flex-1 py-2 text-xs" style={mobileTab === t ? { color: "#f5a623", borderBottom: "2px solid #f5a623" } : { color: "#8b93a1" }}>{label}</button>
          ))}
        </div>
      )}
      {/* 本体 */}
      <div className="flex-1 flex min-h-0">
        {isNarrow && mobileTab === "preview" && previewPane}
        {(!isNarrow || mobileTab === "edit") && editPane}
      </div>
      {/* メニュー */}
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
          <div className="fixed z-40 rounded-lg shadow-xl overflow-auto" style={{ top: 92, right: 8, width: 264, maxHeight: "72vh", background: "#262b34", border: "1px solid #3a4150" }}>
            {knitBusy && (
              <div className="px-3 py-2 text-xs" style={{ color: "#8ef0b6", background: "#14241c", borderBottom: "1px solid #3a4150" }}>
                編み機へ転送中です。パターンを変える操作は止めてあります。変更するには編み機パネルでストップしてください。
              </div>
            )}
            {!editMode && (
              <div className="px-3 py-2 text-xs" style={{ color: "#c9a227", background: "#241f14", borderBottom: "1px solid #3a4150" }}>
                表示モード中です。パターンの読み込み・保存はできます。図案の編集は鉛筆ボタンで編集モードにしてから行えます。
              </div>
            )}
            {editMode && (
            <Section title="編集">
              <MenuBtn onClick={() => { selectAll(); setMenuOpen(false); }}>全選択</MenuBtn>
              <div className="flex items-center px-3 py-1.5 gap-1">
                <span className="text-xs flex-1" style={{ color: "#d7dbe2" }}>シフト(端は回り込み)</span>
                <TB onClick={() => doShift(-1, 0)} title="左へ"><ChevronLeft size={14} /></TB>
                <TB onClick={() => doShift(0, -1)} title="上へ"><ChevronUp size={14} /></TB>
                <TB onClick={() => doShift(0, 1)} title="下へ"><ChevronDown size={14} /></TB>
                <TB onClick={() => doShift(1, 0)} title="右へ"><ChevronRight size={14} /></TB>
              </div>
              <div className="flex items-center px-3 py-1.5 gap-1">
                <span className="text-xs flex-1" style={{ color: "#d7dbe2" }}>全体を反転</span>
                <TB onClick={() => doFlipAll("h")} title="左右反転"><FlipHorizontal2 size={14} /></TB>
                <TB onClick={() => doFlipAll("v")} title="上下反転"><FlipVertical2 size={14} /></TB>
              </div>
              <div className="flex items-center px-3 py-1.5 gap-1">
                <span className="text-xs flex-1" style={{ color: "#d7dbe2" }}>色の入れ替え</span>
                {[0, 1].map((k) => (
                  <select key={k} value={k ? swapB : swapA} onChange={(e) => setSwapSel((s) => { const n = s.slice(); n[k] = +e.target.value; return n; })} className="h-7 rounded text-xs px-1" style={{ background: "#232833", border: "1px solid #333a46", color: "#d7dbe2" }}>
                    {padPalette(doc.palette).slice(0, swapN + 1).map((h, i) => <option key={i} value={i}>{i === 0 ? "地色" : `色${i}`}</option>)}
                  </select>
                ))}
                <TB onClick={() => { if (swapA !== swapB) doSwapColors(swapA, swapB); }} title="入れ替え実行"><Check size={14} /></TB>
              </div>
            </Section>
            )}
            <Section title="検証(編み機の制約チェック)">
              <label className="flex items-center gap-2 px-3 py-1.5 text-xs" style={{ color: "#d7dbe2" }}>
                <input type="checkbox" checked={checks.colors} onChange={(e) => setChecks((c) => ({ ...c, colors: e.target.checked }))} />
                1段の色数 上限
                <input type="number" min={2} max={8} value={checks.maxColors} onChange={(e) => setChecks((c) => ({ ...c, maxColors: clamp(+e.target.value || 2, 2, 8) }))} className="w-12 h-7 rounded text-center" style={{ background: "#232833", border: "1px solid #333a46", color: "#d7dbe2" }} />色
              </label>
              <label className="flex items-center gap-2 px-3 py-1.5 text-xs" style={{ color: "#d7dbe2" }}>
                <input type="checkbox" checked={checks.float} onChange={(e) => setChecks((c) => ({ ...c, float: e.target.checked }))} />
                渡り糸の長さ 上限
                <input type="number" min={2} max={30} value={checks.floatLimit} onChange={(e) => setChecks((c) => ({ ...c, floatLimit: clamp(+e.target.value || 5, 2, 30) }))} className="w-12 h-7 rounded text-center" style={{ background: "#232833", border: "1px solid #333a46", color: "#d7dbe2" }} />目
              </label>
            </Section>
            <Section title="表示">
              <label className="flex items-center gap-2 px-3 py-1.5 text-xs" style={{ color: "#d7dbe2" }}>
                編み目の縦横比(高さ/幅)
                <input type="number" step={0.05} min={0.4} max={1.2} value={doc.gaugeRatio} onChange={(e) => setDoc((p) => ({ ...p, gaugeRatio: clamp(+e.target.value || 0.75, 0.4, 1.2) }))} className="w-16 h-7 rounded text-center" style={{ background: "#232833", border: "1px solid #333a46", color: "#d7dbe2" }} />
              </label>
            </Section>
            <Section title={`パターン集(SR形式テキスト・${library.length} / ${MAX_LIB}件)`}>
              {/* 全データを失わずに保存・復元する(表示色・色番号・色数・全パスの制御4bit・件数) */}
              <MenuBtn hint={saveHint ? SAVE_HINT : null} onClick={() => { exportLibrary(); setMenuOpen(false); }}><Download size={13} /> パターン集を保存(全データ・JSON){saveHint ? " ●未保存" : ""}</MenuBtn>
              <MenuBtn disabled={knitBusy} onClick={() => { libInputRef.current.click(); setMenuOpen(false); }}><Upload size={13} /> パターン集を読み込み(全データ・JSON)</MenuBtn>
              <div className="mx-3 my-1" style={{ borderTop: "1px solid #2a2f38" }} />
              <MenuBtn disabled={knitBusy} onClick={() => { binInputRef.current.click(); setMenuOpen(false); }}><Upload size={13} /> U-BOXカード読み込み(SRバイナリ)</MenuBtn>
              <MenuBtn disabled={knitBusy} onClick={() => { datInputRef.current.click(); setMenuOpen(false); }}><Upload size={13} /> PC10パターン読み込み(.DAT・複数可)</MenuBtn>
              <MenuBtn disabled={knitBusy} onClick={() => { txtInputRef.current.click(); setMenuOpen(false); }}><Upload size={13} /> パターン読み込み(SRテキスト)</MenuBtn>
              <MenuBtn onClick={() => { exportSRTextCurrent(); setMenuOpen(false); }}><Download size={13} /> 現在のパターンをSRテキストで保存</MenuBtn>
              <MenuBtn onClick={() => { exportPC10Zip(); setMenuOpen(false); }}><Download size={13} /> 全てのパターンをPC10用に保存(SRDS.zip)</MenuBtn>
              <MenuBtn onClick={() => { exportPC10Current(); setMenuOpen(false); }}><Download size={13} /> 現在のパターンをPC10用に保存(SRDS.zip / 1件)</MenuBtn>
              <MenuBtn onClick={() => { exportUBox(); setMenuOpen(false); }}><Download size={13} /> 全てのパターンをU-BOXカード保存(SRバイナリ)</MenuBtn>
              <MenuBtn onClick={() => { exportSRText(); setMenuOpen(false); }}><Download size={13} /> 全てのパターンをテキスト保存(SRテキスト)</MenuBtn>
              <MenuBtn hint={addHint ? ADD_HINT : null} onClick={addToLibrary}><Plus size={13} /> 現在のパターンを追加{addHint ? " ●未登録" : ""}</MenuBtn>
              {/* 取り込んだパターンの一覧は操作ボタンの下に置く。上部に結びついたファイル名を出す */}
              {library.length > 0 && (libName || libMemo) && <div className="mx-3 mt-1 rounded overflow-hidden">{libNameBar("px-2")}</div>}
              {library.length > 0 && <div className="mx-3 my-1" style={{ borderTop: "1px solid #2a2f38" }} />}
              {library.map((e, i) => (
                <div key={i} className="flex items-center gap-1 px-3 py-1">
                  <span className="text-xs flex-1" style={{ color: "#d7dbe2" }}>{srName(i)}  {e.s}×{e.r}{e.colors > 1 ? `  地+${e.colors}色` : ""}</span>
                  <button disabled={knitBusy} onClick={() => { if (editMode) copyEntryToGhost(e, srName(i)); else loadEntry(e, srName(i)); setMenuOpen(false); }} className="h-7 px-2 rounded text-xs disabled:opacity-40" style={{ background: "#333a46", color: "#c8cdd6" }}
                    title={editMode ? "このパターンをコピーして図案の上に置く(ドラッグで位置を決めて「確定」で貼り付け)" : "このパターンを開く"}>{editMode ? "コピー" : "読込"}</button>
                  <button disabled={editMode} onClick={() => exportPC10Single(e)} className="h-7 px-2 rounded text-xs disabled:opacity-40" style={{ background: "#333a46", color: "#c8cdd6" }} title={editMode ? "編集モードでは使えません" : "このパターンをSRDS一式(SRDS.zip)で保存"}>DAT</button>
                  <button disabled={editMode} onClick={() => { setMenuOpen(false); deleteEntry(i); }} className="h-7 px-2 rounded text-xs disabled:opacity-40" style={{ color: "#f87171" }} title={editMode ? "編集モードでは使えません" : "パターン集から削除"}>×</button>
                </div>
              ))}
              {library.length > 0 && <MenuBtn onClick={() => { setPickerNew(null); setPickerOpen(true); setMenuOpen(false); }}><Library size={13} /> 一覧をウィンドウで開く</MenuBtn>}
            </Section>
            <Section title="ファイル">
              <MenuBtn onClick={() => { exportJSON(); setMenuOpen(false); }}><Download size={13} /> JSON書き出し(現在のパターン)</MenuBtn>
              <MenuBtn disabled={knitBusy} onClick={() => { fileInputRef.current.click(); setMenuOpen(false); }}><Upload size={13} /> JSON読み込み(現在のパターン)</MenuBtn>
              <MenuBtn onClick={() => { exportChartPNG(); setMenuOpen(false); }}><Download size={13} /> 図案PNG(番号・枠付き)</MenuBtn>
              <MenuBtn onClick={() => { exportMachinePNG(); setMenuOpen(false); }}><Download size={13} /> 機械用PNG(1目=1px)</MenuBtn>
            </Section>
            {editMode && (
            <Section title="">
              <MenuBtn danger disabled={knitBusy} onClick={() => { setMenuOpen(false); doClearAll(); }}><Trash2 size={13} /> 全消去</MenuBtn>
            </Section>
            )}
          </div>
        </>
      )}
      {/* スウォッチ長押しメニュー */}
      {swatchMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setSwatchMenu(null)} />
          <div className="fixed z-40 rounded-lg shadow-xl py-1" style={{ left: Math.max(8, Math.min(swatchMenu.x, (window.innerWidth || 400) - 190)), top: Math.max(8, Math.min(swatchMenu.y, (window.innerHeight || 600) - 170)), width: 180, background: "#262b34", border: "1px solid #3a4150" }}>
            {swatchMenu.mode === "menu" ? (
              <>
                <MenuBtn onClick={() => openColorBar(swatchMenu.index)}>カラー変更バーを開く</MenuBtn>
                <MenuBtn onClick={() => setSwatchMenu((m) => ({ ...m, mode: "replace" }))}>この色番号を一括置換 →</MenuBtn>
                {swatchMenu.index > 0
                  ? <MenuBtn danger onClick={() => clearColor(swatchMenu.index)}>このマスを地色に戻す</MenuBtn>
                  : <div className="px-3 py-1" style={{ fontSize: 10, color: "#77808f" }}>※色番号は固定(削除や詰め直しはしません)</div>}
              </>
            ) : (
              <div className="p-2">
                <div className="mb-1" style={{ fontSize: 10, color: "#9aa2b0" }}>置換先の色をタップ</div>
                <div className="grid grid-cols-4 gap-1.5">
                  {padPalette(doc.palette).slice(0, clamp(doc.colors || 1, 1, MAX_COLOR_NO) + 1).map((hex, i) => i === swatchMenu.index ? null : (
                    <button key={i} onClick={() => replaceColor(swatchMenu.index, i)} title={i === 0 ? "地色" : `色${i}`} className="h-7 rounded" style={{ background: hex, border: "1px solid rgba(0,0,0,.35)" }} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {gridMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setGridMenu(null)} />
          <div className="fixed z-40 rounded-lg shadow-xl py-1" style={{ left: Math.max(8, Math.min(gridMenu.x, (window.innerWidth || 400) - 236)), top: Math.max(8, Math.min(gridMenu.y, (window.innerHeight || 600) - 320)), width: 226, background: "#262b34", border: "1px solid #3a4150" }}>
            <div className="px-3 pt-1.5 pb-1" style={{ fontSize: 10, color: "#77808f", letterSpacing: "0.04em" }}>
              {gridMenu.kind === "col" ? `${gridMenu.col + 1}目目` : gridMenu.kind === "row" ? `${R - gridMenu.row}段目` : `${R - gridMenu.row}段目 / ${gridMenu.col + 1}目`}
            </div>
            {gridMenu.kind !== "col" && (<>
              <div className="px-3 pt-1 pb-0.5" style={{ fontSize: 10, color: "#8b93a1" }}>段(横の列)</div>
              <MenuBtn onClick={() => { insertRow(gridMenu.row, "above"); setGridMenu(null); }}>
                <ChevronUp size={14} />この段の上に1段追加
              </MenuBtn>
              <MenuBtn onClick={() => { insertRow(gridMenu.row, "below"); setGridMenu(null); }}>
                <ChevronDown size={14} />この段の下に1段追加
              </MenuBtn>
              <MenuBtn danger onClick={() => { deleteRow(gridMenu.row); setGridMenu(null); }}>
                <Trash2 size={14} />この段({R - gridMenu.row}段目)を削除
              </MenuBtn>
            </>)}
            {gridMenu.kind !== "row" && (<>
              <div className="px-3 pt-1.5 pb-0.5" style={{ fontSize: 10, color: "#8b93a1", borderTop: gridMenu.kind === "col" ? "none" : "1px solid #313847", marginTop: gridMenu.kind === "col" ? 0 : 2 }}>目(縦の列)</div>
              <MenuBtn onClick={() => { insertCol(gridMenu.col, "left"); setGridMenu(null); }}>
                <ChevronLeft size={14} />この目の左に1目追加
              </MenuBtn>
              <MenuBtn onClick={() => { insertCol(gridMenu.col, "right"); setGridMenu(null); }}>
                <ChevronRight size={14} />この目の右に1目追加
              </MenuBtn>
              <MenuBtn danger onClick={() => { deleteCol(gridMenu.col); setGridMenu(null); }}>
                <Trash2 size={14} />この目({gridMenu.col + 1}目目)を削除
              </MenuBtn>
            </>)}
          </div>
        </>
      )}
      {saveBox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(10,12,16,0.6)" }}>
          <div className="rounded-lg shadow-xl p-4 mx-4 w-full overflow-y-auto" style={{ background: "#262b34", border: "1px solid #3a4150", maxWidth: 420, maxHeight: "92vh" }}>
            <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: "#e6e9ee" }}><Save size={15} /> パターン集を保存（{library.length}件）</p>
            <label className="block text-xs mt-3 mb-1" style={{ color: "#9aa2b0" }} htmlFor="lib-save-name">ファイル名</label>
            <input
              id="lib-save-name" ref={saveNameRef} type="text" value={saveBox.name} spellCheck={false}
              onChange={(e) => setSaveBox((b) => ({ ...b, name: e.target.value, error: "" }))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmSaveLibrary(); } }}
              className="w-full h-9 px-2 rounded text-sm"
              style={{ background: "#1f242c", border: `1px solid ${saveBox.error ? "#a3462f" : "#3a4150"}`, color: "#e6e9ee" }}
            />
            {saveBox.error && <p className="text-xs mt-1" style={{ color: "#f87171" }}>{saveBox.error}</p>}
            <div className="flex items-end justify-between mt-3 mb-1">
              <label className="block text-xs" style={{ color: "#9aa2b0" }} htmlFor="lib-save-memo">
                メモ<span style={{ color: "#77808f" }}>（任意・パターン集と一緒に保存）</span>
              </label>
              <span className="text-xs tabular-nums" style={{ color: saveBox.memo && saveBox.memo.length >= LIB_MEMO_MAX ? "#f5a623" : "#77808f" }}>
                {(saveBox.memo || "").length} / {LIB_MEMO_MAX}
              </span>
            </div>
            <textarea
              id="lib-save-memo" value={saveBox.memo || ""} rows={LIB_MEMO_ROWS} spellCheck={false}
              placeholder={"このパターン集の覚え書き\n（糸・針・ゲージ・サイズなど）"}
              onChange={(e) => setSaveBox((b) => ({ ...b, memo: e.target.value.slice(0, LIB_MEMO_MAX), error: "" }))}
              className="w-full px-2 py-1.5 rounded text-sm resize-none overflow-y-auto"
              style={{
                background: "#1f242c", border: "1px solid #3a4150", color: "#e6e9ee",
                width: `calc(${LIB_MEMO_COLS}em + 20px)`, maxWidth: "100%",
                height: `calc(${LIB_MEMO_ROWS} * 1.7em + 14px)`, lineHeight: 1.7,
              }}
            />
            <p className="text-xs mt-2" style={{ color: "#77808f", lineHeight: 1.6 }}>
              メモは全角{LIB_MEMO_COLS}字 × {LIB_MEMO_ROWS}行ぶんの枠です。それより多く書いても枠の中でスクロールします。
              読み込むとパターン集ウィンドウのファイル名の下に出ます。
            </p>
            <p className="text-xs mt-2" style={{ color: "#77808f", lineHeight: 1.6 }}>
              .json は省略できます。保存先はブラウザのダウンロード先です。同じ名前のファイルがあると、ブラウザが (1) などを付けて別名で保存することがあります。
            </p>
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setSaveBox(null)} className="h-9 px-3 rounded-md text-xs" style={{ background: "#333a46", color: "#c8cdd6" }}>キャンセル</button>
              <button onClick={confirmSaveLibrary} className="h-9 px-4 rounded-md text-xs font-medium" style={{ background: "#f5a623", color: "#1d1d1d" }}>保存</button>
            </div>
          </div>
        </div>
      )}
      {confirmBox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(10,12,16,0.6)" }}>
          <div className="rounded-lg shadow-xl p-4 mx-4" style={{ background: "#262b34", border: "1px solid #3a4150", maxWidth: 320 }}>
            <p className="text-sm mb-4 whitespace-pre-line" style={{ color: "#e6e9ee", lineHeight: 1.6 }}>{confirmBox.msg}</p>
            <div className="flex flex-wrap justify-end gap-2">
              {!confirmBox.okOnly && <button onClick={() => setConfirmBox(null)} className="h-9 px-3 rounded-md text-xs" style={{ background: "#333a46", color: "#c8cdd6" }}>キャンセル</button>}
              {confirmBox.altLabel && <button onClick={() => { const f = confirmBox.onAlt; setConfirmBox(null); if (f) f(); }} className="h-9 px-3 rounded-md text-xs font-medium" style={{ background: "#3d4656", color: "#e6e9ee", border: "1px solid #566074" }}>{confirmBox.altLabel}</button>}
              <button onClick={() => { const f = confirmBox.onOk; setConfirmBox(null); if (f) f(); }} className="h-9 px-3 rounded-md text-xs font-medium" style={{ background: "#f5a623", color: "#1d1d1d" }}>{confirmBox.okLabel || "OK"}</button>
            </div>
          </div>
        </div>
      )}
      <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={importJSON} />
      <input ref={txtInputRef} type="file" accept=".txt,text/plain" className="hidden" onChange={importSRText} />
      <input ref={binInputRef} type="file" className="hidden" onChange={importUBox} />
      <input ref={datInputRef} type="file" accept=".DAT,.dat" multiple className="hidden" onChange={importPC10} />
      <input ref={libInputRef} type="file" accept=".json,application/json" className="hidden" onChange={importLibrary} />
      {knitCtrl && <KnitControl doc={doc} onClose={() => setKnitCtrl(false)} onRunningChange={setKnitRunning} lastConn={lastConn} onConnInfo={setLastConn} calSide={calSide} onCalSide={setCalSide} onDeviceBye={onKnitDeviceBye} />}
      {toast && (
        <div className="fixed bottom-4 z-50 px-3 py-2 rounded-lg text-xs shadow-lg" style={{ left: "50%", transform: "translateX(-50%)", background: "#2f3542", color: "#e6e9ee", border: "1px solid #444c5c" }}>{toast}</div>
      )}
      {/* パターン集ピッカー(モバイル・ボトムシート)。フローティング窓が使えない狭い画面用 */}
      {isNarrow && pickerOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center" style={{ background: "rgba(0,0,0,.55)" }} onClick={() => setPickerOpen(false)}>
          <div className="w-full flex flex-col overflow-hidden" style={{ maxHeight: "82vh", background: "#1a1e26", borderTop: "1px solid #3a4150", borderTopLeftRadius: 16, borderTopRightRadius: 16 }} onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ background: "#2f3542" }}>
              <span className="text-sm font-medium flex items-center gap-1.5" style={{ color: "#c8cdd6" }}>
                <Library size={15} /> パターン集({library.length}件)
              </span>
              <div className="flex items-center gap-1">
                <button disabled={libFull} onClick={addToLibrary} className="p-1.5 rounded hover:bg-slate-600 disabled:opacity-40" style={hintBtn(addHint, ADD_HINT, "#10241a")} title={addTitle}><BookPlus size={17} /></button>
                <button disabled={knitBusy} onClick={() => libInputRef.current.click()} className="p-1.5 rounded hover:bg-slate-600 disabled:opacity-40" style={{ color: "#9aa2b0" }} title="パターン集を読み込み(全データ・JSON)"><FolderOpen size={17} /></button>
                <button onClick={exportLibrary} className="p-1.5 rounded hover:bg-slate-600" style={hintBtn(saveHint, SAVE_HINT, "#fff")} title={saveTitle}><Save size={17} /></button>
                <button onClick={() => setPickerOpen(false)} className="p-1 rounded hover:bg-slate-600" style={{ color: "#9aa2b0" }} title="閉じる"><X size={18} /></button>
              </div>
            </div>
            {libNameBar("px-3")}
            {pickerBody}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================== 小物 ============================== */
/* hint = [背景色, 文字色]。操作を促すときに色を付ける(パターン集への追加・保存) */
function TB({ active, onClick, title, children, disabled, hint }) {
  return (
    <button
      title={title} disabled={disabled} onClick={onClick}
      className={"h-9 px-2 rounded-md flex items-center justify-center gap-1 text-xs whitespace-nowrap shrink-0 transition-colors " + (active || hint ? "" : "hover:bg-slate-700") + " disabled:opacity-30"}
      style={active ? { background: "#f5a623", color: "#20242c" } : hint ? { background: hint[0], color: hint[1], boxShadow: `0 0 0 2px ${hint[0]}55` } : { color: "#c3c9d4" }}
    >{children}</button>
  );
}
function MenuBtn({ onClick, children, danger, disabled, hint }) {
  return (
    <button disabled={disabled} onClick={onClick}
      className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-slate-700 disabled:opacity-30"
      style={{ color: danger ? "#f87171" : hint || "#d7dbe2", fontWeight: hint ? 600 : undefined }}
    >{children}</button>
  );
}
function Section({ title, children }) {
  return (
    <div className="py-1" style={{ borderBottom: "1px solid #313847" }}>
      {title && <div className="px-3 pt-1.5 pb-0.5" style={{ fontSize: 10, color: "#77808f", letterSpacing: "0.06em" }}>{title}</div>}
      {children}
    </div>
  );
}
