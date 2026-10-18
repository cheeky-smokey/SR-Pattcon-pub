/*
  SRCarriageSim.ino — Silver Reed 電子キャリッジ シミュレータ
  対象ボード: Arduino UNO R4 Minima / UNO R4 WiFi

  キャリッジが出す信号 (ONP / OCD / OPC / ON1) を生成し、コントローラが返す INS を
  1 目ずつ読み取って「実際に選針された段」を記録・表示する。
  編み機なしで KnitCtrl_M5 などのコントローラを開発・検証するための装置。

  ■ 信号 (2026-10-17 再定義。記号を読みやすくし、DIN のピン番号を実機に合わせて直した。カッコ内は旧称)
      記号  本機  向き  意味
      OCD   D5    出力  キャリッジ方向 (Out Carriage Direction。旧 HOK)
                        H = 左←右 (左行き) / L = 左→右 (右行き)
      ONP   D6    出力  編み目カウント (Out Needle Pulse。旧 CCP)  立上り (L→H) で 1 目進んだ
      OPC   D8    出力  パターン出力フラグ (Out Point Cam。旧 KSL)
                        H = ポイントカム有効区間。H の間、選針にパターンを出力する
                        1 回のキャリッジ移動で H の区間は最大 2 か所
                        最初の編み出し時にパルスあり
      ON1   D9    出力  カーソル (Out Needle 1。旧 ND1。パターン基準目 = パターンのスタート位置)
                        カーソル通過で L パルス (ネガティブインパルス)。キャリッジのスタート時と反転時にも L パルス
                        パターンは基準目を中央に前後へ、OPC が H の間出力される
                        カーソルは 2 つまで (カーソル1・2)。2 つあると 1 回の走行で
                        ON1 のカーソルパルスが 2 回出る (needle1-1 / needle1-2)
      INS   D7    入力  選針 (In Needle Select。旧 DOB)  H = 平編み / L = 編み込み (選針)。
                        内部プルアップ (未接続 = 平編み)
      GND   共通
      D2 ボタン(GND へ) = 1パス / D3 ボタン(GND へ) = 自動往復 開始・停止
      D13 LED = OPC が H の間点灯 / UNO R4 WiFi は LED マトリクスに直近 8 段を表示

  ■ コネクタ (XH 8 ピン ⇔ DIN 7 ピン メス、2026-10-17)
      名称     XH  ケーブル色  DIN   内容
      Vcc(5V)  1   白          7
      GND      2   緑          キー
      16V      3   黄          6     本機のピンにはつながない (UNO R4 は 5V)
      ONP      4   青          4     L→H 立ち上がりパルス
      OPC      5   黒          5     H = ポイントカム有効区間
      ON1      6   赤          1     カーソル (ネガティブインパルス)
      OCD      7   灰          2     キャリッジ方向  H = 左←右 / L = 左→右
      INS      8   オレンジ    3     選針  H = 平編み / L = 編み込み

  ■ カーソルとポイントカム (実機, 2026-09)
      - カーソルが 2 つのとき、OPC のポイントカムは 4 個 (PointCam1〜4) になることがある
      - ポイントカム 1〜4 とカーソル 1・2 は、順番に関係なく自由な針位置に置ける
      - 本機ではポイントカムを針番号順に並べ、1-2 番目の間を OPC 区間 1、
        3-4 番目の間を OPC 区間 2 とする (cam A B [C D]、順不問)
      - 基準目の算出 (実機の規則として受けた内容。本機は @ROW の ref1/ref2 に出す):
        OPC 区間内でカーソルパルスが出たら、その目を基準目とする。
        区間内にカーソルパルスがなければ、区間の中央 (2 つのポイントカムの中央) を基準目とする。
        区間の外 (区間 1 と 2 の間など) のカーソルパルスは無視する。
        1 つの区間に 2 回出た場合は、走行順で先のものを使う (この扱いは未確認)

  ■ ロジアナ波形 (EC1 接続, 2026-09) から読み取った動き
      - スタート時: OCD 切替と同時に ON1 L パルス + OPC 編み出しパルス (最初の 1 回だけ)
      - 反転時: OCD 切替と同時に ON1 L パルス (OPC パルスなし)
      - OCD が切り替わる前に、新しい向きの ONP が数発出る (dirlag)
      - OPC 区間はカーソルに対して進行方向の先へずれる (左行き: カーソル通過が区間の後 /
        右行き: 区間の途中)。本機では「選針位置 = 基準位置 + 進行方向 × offset」で表す
      - EC1 は OPC が L の間 INS を H (平編み) に保つ

  ★ まだ数値を確かめていないもの (シリアルコマンドで変えられる。save で保存)
      - offset (選針位置の先行目数)、dirlag (OCD が遅れる ONP 数)
        → ロジアナで「OPC↑→カーソル」「動き始め→OCD 切替」の ONP 数を数えて合わせる
      - INS を読むタイミング (sample fall|rise)
      - ON1 / OPC パルスの幅 (本機では 1 目ぶん)
      - 1 つの OPC 区間にカーソルが 2 つあるときの基準目
      - 折り返しのクロックの出方 (本機では端の針を往路・復路の両方で数える)

  ■ 1 パスの動き (右行きの例。左行きは左右反転)
      lead [us] 待つ → 針ごとに:
        (dirlag 目めで OCD 切替 + ON1 パルス [+ 編み出し OPC パルス])
        OPC/ON1 を更新 → ONP↑ → (period×duty) → [sample fall なら INS 読取] ONP↓
        → 次の ONP↑ 直前 [sample rise なら INS 読取]
      OPC は「選針位置 (基準位置 + 進行方向×offset)」が区間内のとき H。
      走行範囲 = OPC 区間の外側 margin 目 〜 反対側の外側 margin 目 (基準位置で)。
      パス終了時に @WAVE 行で 1 目ごとの信号レベルを出す (ビューアで波形表示)。

  ■ 電圧: キャリッジは 5V。UNO R4 も 5V ロジック。M5Stack (ESP32, 3.3V) とつなぐときは
    レベル変換を入れる (本機→M5 の 4 本は 5V→3.3V、INS は 3.3V→5V)。

  ■ 針番号: 編み針は最大 240 本。L120..L1 = 0..119, R1..R120 = 120..239。
    コマンドは "L30" "R30" でも数値 (0..239) でも可。

  シリアル 115200bps。"?" でコマンド一覧。"@" で始まる行はビューア用の機械可読行。
*/

#include <Arduino.h>
#include <EEPROM.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <ctype.h>

#if defined(ARDUINO_UNOWIFIR4)
  #include "Arduino_LED_Matrix.h"
  #define SIM_HAS_MATRIX 1
#else
  #define SIM_HAS_MATRIX 0
#endif

#define SIM_VERSION "1017"

// ---- ピン ---------------------------------------------------------------------
static const uint8_t PIN_OCD      = 5;    // DIN 2 / XH 7 (灰)  キャリッジ方向
static const uint8_t PIN_ONP      = 6;    // DIN 4 / XH 4 (青)  編み目カウント
static const uint8_t PIN_INS      = 7;    // DIN 3 / XH 8 (橙)  選針 (入力)
static const uint8_t PIN_OPC      = 8;    // DIN 5 / XH 5 (黒)  ポイントカム有効区間
static const uint8_t PIN_ON1      = 9;    // DIN 1 / XH 6 (赤)  カーソル
static const uint8_t PIN_BTN_PASS = 2;
static const uint8_t PIN_BTN_AUTO = 3;
static const uint8_t PIN_OPC_LED  = LED_BUILTIN;

static const int16_t  NEEDLES   = 240;              // 編み針の最大数。L120..L1 = 0..119 / R1..R120 = 120..239
static const int16_t  HALF      = NEEDLES / 2;      // 片側の本数 (L1 = HALF-1, R1 = HALF)
static const uint8_t  ROW_BYTES = (NEEDLES + 7) / 8;
static const uint8_t  HIST_ROWS = 64;
static const uint32_t CFG_MAGIC = 0x53524336UL;     // "SRC6" (構造体や針番号の意味を変えたら上げる)
static const int16_t  WAVE_MAX  = NEEDLES + 4 * 60; // 1 パスの最大クロック数 (全針 + 両側の余白 60 と offset 60)
static const uint16_t SPS_MIN = 1, SPS_MAX = 2000;

// ---- 型 (Arduino IDE の自動プロトタイプより前に置く) -------------------------------
struct SimConfig {
  uint32_t magic;
  uint16_t sps;          // 走行速度 [目/秒]
  int16_t  camL, camR;   // OPC 区間 1 (ポイントカム 1・2。針番号順に並べ替え済み)
  int16_t  cam2L, cam2R; // OPC 区間 2 (ポイントカム 3・4。-1 = なし。camR < cam2L)
  int16_t  on1;          // カーソル 1 (パターン基準目)
  int16_t  on1b;         // カーソル 2 (-1 = なし)
  int16_t  margin;       // OPC 区間の外側へ走る目数
  int16_t  offset;       // 選針位置の先行 (選針位置 = 基準位置 + 進行方向×offset)
  int16_t  matL;         // LED マトリクスの左端針 (-1 = 区間の左端)
  uint16_t pauseMs;      // 自動往復のパス間
  uint16_t leadUs;       // パス開始 (@PASS 出力) → 最初の ONP↑
  uint16_t warnSetupUs;  // INS 変化 → 読取 がこれ未満なら setup 警告
  uint16_t warnHoldUs;   // 読取 → INS 変化 がこれ未満なら hold 警告
  uint8_t  duty;         // ONP High の比率 [%]
  uint8_t  sampleRise;   // 0 = ONP↓で読む / 1 = 次の ONP↑ 直前で読む
  uint8_t  on1Edge;      // 1 = スタート/反転時に ON1 L パルスを出す
  uint8_t  opcImp;       // 1 = 最初の編み出しで OPC パルスを出す
  uint8_t  dirLag;       // 動き始めてから OCD を切り替えるまでの ONP 数
  uint8_t  ocdRight;     // 右行きのときの OCD レベル   (実機: L)
  uint8_t  on1Act;       // ON1 のアクティブレベル      (実機: L)
  uint8_t  opcIn;        // パターン出力中の OPC レベル (実機: H)
  uint8_t  insSel;       // 選針を表す INS レベル       (実機: L = GND)
};

enum SimPhase : uint8_t { PH_IDLE, PH_PAUSE, PH_LEAD, PH_HIGH, PH_LOW };

struct PassStat {
  uint16_t samples;      // 読んだ針の数 (OPC 区間内)
  uint16_t sel;          // 選針された針の数
  uint16_t changes;      // 走行中の INS 変化回数
  uint16_t setupViol;
  uint16_t holdViol;
  uint8_t  opcPulses;    // OPC が H になった回数 (編み出しパルス込み)
  uint8_t  on1Pulses;    // ON1 が有効になった回数 (スタート/反転パルス込み)
  int16_t  k2c;          // OPC↑ → カーソル通過 の ONP 数 (NO_K2C = どちらかなし)
  int16_t  ref2x[2];     // 区間 1・2 の基準目 × 2 (半目を表すため 2 倍。区間なしは NO_REF)
  char     refSrc[2];    // 'c' = 区間内のカーソル / 'm' = 区間の中央 / '-' = 区間なし
  uint8_t  ign;          // 基準目に使わなかったカーソルパルスの数 (区間外・同じ区間の 2 回目)
  uint32_t minSetup;     // INS 変化 → 読取 の最小 [us]
  uint32_t maxLat;       // ONP↑ → INS 変化 の最大 [us]
};

struct RowRec {
  uint16_t no;
  int8_t   dir;
  int16_t  l1, r1, l2, r2;   // その段の OPC 区間 (l2 = -1 なら 1 区間)
  PassStat st;
  uint8_t  bits[ROW_BYTES];
};

static const int16_t NO_K2C = 9999;
static const int16_t NO_REF = -1;
static const uint8_t CUR_MAX = 4;          // 1 パスで記録するカーソルパルスの最大数

struct Button {
  uint8_t  pin;
  bool     stable;
  bool     last;
  uint32_t tChange;
};

// ---- 状態 ---------------------------------------------------------------------
SimConfig cfg;
SimPhase  ph       = PH_IDLE;
int16_t   pos      = 0;        // キャリッジ位置 (針番号。盤外は負や NEEDLES 以上)
int16_t   endPos   = 0;
int8_t    dir      = 1;        // +1 = 右行き / -1 = 左行き
int8_t    side     = 1;        // キャリッジの居場所: +1 = 右端 / -1 = 左端
uint32_t  tStep    = 0;        // 現ステップの ONP↑ 予定時刻
uint32_t  tPause   = 0;
uint32_t  periodUs = 0;
uint32_t  highUs   = 0;
bool      autoOn   = false;
bool      autoInf  = false;
uint16_t  autoLeft = 0;
uint16_t  passNo   = 0;
bool      opcImpPending = true;    // 次のパスが最初の編み出し
bool      opcImpThis    = false;
bool      opcOut        = false;   // 出力中の論理状態 (true = パターン出力 / 有効)
bool      on1Out        = false;
bool      ocdLevel      = false;   // OCD ピンのレベル
int16_t   startPos      = 0;
int16_t   stepIdx       = 0;       // パス内のクロック番号
int16_t   opcFirst      = -1;      // OPC 区間に入ったクロック
int16_t   curIdx        = -1;      // カーソルを通過したクロック (最初の 1 回)
uint8_t   curN          = 0;       // このパスのカーソルパルスの数
int16_t   curSel[CUR_MAX];         // カーソルパルスのときの選針位置
uint8_t   curWin[CUR_MAX];         // そのとき OPC が H だった区間 (0 = 区間外 / 1 / 2)
uint8_t   wave[WAVE_MAX];          // 1 目ごとの信号レベル b0 OPC b1 ON1 b2 INS b3 OCD (ピンの H=1)
uint8_t   cur[ROW_BYTES];
PassStat  st;
bool      insLast       = false;
uint32_t  tInsChange    = 0;
uint32_t  tRise         = 0;
uint32_t  tSample       = 0;
bool      sampledInPass = false;
RowRec    hist[HIST_ROWS];
uint8_t   histHead  = 0;
uint8_t   histCount = 0;
char      line[96];
uint8_t   lineLen = 0;
char      obuf[WAVE_MAX + 160];    // @WAVE 行 (約45字 + 480クロック) / @ROW 行が収まる大きさ
Button    btnPass = { PIN_BTN_PASS, true, true, 0 };
Button    btnAuto = { PIN_BTN_AUTO, true, true, 0 };
#if SIM_HAS_MATRIX
ArduinoLEDMatrix matrix;
uint8_t frame[8][12];
#endif

// ---- 小物 ---------------------------------------------------------------------
static inline bool due(uint32_t now, uint32_t t) { return (int32_t)(now - t) >= 0; }
static inline void setBit(uint8_t* b, int16_t i) { b[i >> 3] |= (uint8_t)(1u << (i & 7)); }
static inline bool getBit(const uint8_t* b, int16_t i) { return (b[i >> 3] >> (i & 7)) & 1; }
static inline bool inWin(int16_t l1, int16_t r1, int16_t l2, int16_t r2, int16_t p) {
  return (p >= l1 && p <= r1) || (l2 >= 0 && p >= l2 && p <= r2);
}
static inline bool inside(int16_t p) { return inWin(cfg.camL, cfg.camR, cfg.cam2L, cfg.cam2R, p); }
static inline int16_t selPos() { return pos + dir * cfg.offset; }   // 選針位置
static inline uint8_t winOf(int16_t p) {                                // p が入る区間 (0 = なし)
  if (p >= cfg.camL && p <= cfg.camR) return 1;
  if (cfg.cam2L >= 0 && p >= cfg.cam2L && p <= cfg.cam2R) return 2;
  return 0;
}
static inline int16_t spanL(int16_t l1, int16_t l2) { return (l2 >= 0 && l2 < l1) ? l2 : l1; }
static inline int16_t spanR(int16_t r1, int16_t l2, int16_t r2) { return (l2 >= 0 && r2 > r1) ? r2 : r1; }

static void say(const char* s) { Serial.println(s); }

// 針番号 → "L30" / "R30"
static const char* needleName(int16_t i, char* buf) {
  if (i < HALF) snprintf(buf, 8, "L%d", HALF - i);
  else          snprintf(buf, 8, "R%d", i - HALF + 1);
  return buf;
}

// "L30" / "R30" / "90" → 針番号
static bool parseNeedle(const char* s, int16_t* out) {
  if (!s || !*s) return false;
  char* end = nullptr;
  char c = (char)toupper((unsigned char)s[0]);
  if (c == 'L' || c == 'R') {
    long n = strtol(s + 1, &end, 10);
    if (end == s + 1 || *end || n < 1 || n > HALF) return false;
    *out = (int16_t)(c == 'L' ? HALF - n : HALF - 1 + n);
    return true;
  }
  long n = strtol(s, &end, 10);
  if (end == s || *end || n < 0 || n >= NEEDLES) return false;
  *out = (int16_t)n;
  return true;
}

static bool parseLong(const char* s, long lo, long hi, long* out) {
  if (!s || !*s) return false;
  char* end = nullptr;
  long v = strtol(s, &end, 10);
  if (end == s || *end || v < lo || v > hi) return false;
  *out = v;
  return true;
}

// ---- 設定 ---------------------------------------------------------------------
static void setDefaults() {
  cfg.magic       = CFG_MAGIC;
  cfg.sps         = 150;
  cfg.camL        = HALF - 30;   // L30
  cfg.camR        = HALF + 29;   // R30
  cfg.cam2L       = -1;
  cfg.cam2R       = -1;
  cfg.on1         = HALF;        // R1
  cfg.on1b        = -1;
  cfg.margin      = 12;
  cfg.offset      = 0;
  cfg.matL        = -1;
  cfg.pauseMs     = 400;
  cfg.leadUs      = 2000;
  cfg.warnSetupUs = 50;
  cfg.warnHoldUs  = 10;
  cfg.duty        = 50;
  cfg.sampleRise  = 0;
  cfg.on1Edge     = 1;
  cfg.opcImp      = 1;
  cfg.dirLag      = 0;
  cfg.ocdRight    = 0;     // 実機: L = 左→右
  cfg.on1Act      = 0;     // 実機: L パルス
  cfg.opcIn       = 1;     // 実機: H = パターン出力
  cfg.insSel      = 0;     // 実機: GND = 選針 / 5V = 平編み
}

static bool cfgValid(const SimConfig& c) {
  bool w2 = (c.cam2L == -1 && c.cam2R == -1) ||
            (c.cam2L > c.camR && c.cam2R < NEEDLES && c.cam2L < c.cam2R);
  return c.magic == CFG_MAGIC && c.sps >= SPS_MIN && c.sps <= SPS_MAX &&
         c.camL >= 0 && c.camR < NEEDLES && c.camL < c.camR && w2 &&
         c.on1 >= 0 && c.on1 < NEEDLES && c.on1b >= -1 && c.on1b < NEEDLES && c.margin >= 1 && c.margin <= 60 &&
         c.offset >= -60 && c.offset <= 60 && c.matL >= -1 && c.matL < NEEDLES &&
         c.duty >= 5 && c.duty <= 95 && c.sampleRise <= 1 && c.on1Edge <= 1 && c.opcImp <= 1 && c.dirLag <= 20 &&
         c.ocdRight <= 1 && c.on1Act <= 1 && c.opcIn <= 1 && c.insSel <= 1;
}

static void applyTiming() {
  periodUs = 1000000UL / cfg.sps;
  highUs   = periodUs * cfg.duty / 100;
  if (highUs < 1) highUs = 1;
  if (highUs >= periodUs) highUs = periodUs - 1;
}

static bool loadConfig() {
  SimConfig c;
  EEPROM.get(0, c);
  if (!cfgValid(c)) return false;
  cfg = c;
  applyTiming();
  return true;
}

static void saveConfig() {
  cfg.magic = CFG_MAGIC;
  EEPROM.put(0, cfg);
}

// ---- 出力ピン -------------------------------------------------------------------
static inline void pinLevel(uint8_t pin, bool hi) { digitalWrite(pin, hi ? HIGH : LOW); }
static inline void outOnp(bool hi)  { pinLevel(PIN_ONP, hi); }
static inline void outOcd(int8_t d) {
  ocdLevel = d > 0 ? cfg.ocdRight : !cfg.ocdRight;
  pinLevel(PIN_OCD, ocdLevel);
}
static void outOn1(bool on) {
  if (on && !on1Out && st.on1Pulses < 255) st.on1Pulses++;
  on1Out = on;
  pinLevel(PIN_ON1, on ? cfg.on1Act : !cfg.on1Act);
}
static void outOpc(bool on) {
  if (on && !opcOut && st.opcPulses < 255) st.opcPulses++;
  opcOut = on;
  pinLevel(PIN_OPC, on ? cfg.opcIn : !cfg.opcIn);
  pinLevel(PIN_OPC_LED, on);
}
static inline bool readIns() { return digitalRead(PIN_INS) == HIGH; }

static void outRest() { outOnp(false); outOpc(false); outOn1(false); }

// ---- 表示 ---------------------------------------------------------------------
static void printCfg() {
  char a[8], b[8], c2[8], d2[8], n[8], n2[8];
  snprintf(obuf, sizeof(obuf),
           "@CFG ver=" SIM_VERSION " sps=%u l=%d r=%d l2=%d r2=%d on1=%d on1b=%d margin=%d offset=%d sample=%s duty=%u "
           "pause=%u lead=%u on1e=%u opcimp=%u dirlag=%u ocd=%u on1a=%u opc=%u ins=%u ws=%u wh=%u mat=%d side=%c",
           cfg.sps, cfg.camL, cfg.camR, cfg.cam2L, cfg.cam2R, cfg.on1, cfg.on1b, cfg.margin, cfg.offset,
           cfg.sampleRise ? "rise" : "fall", cfg.duty, cfg.pauseMs, cfg.leadUs, cfg.on1Edge, cfg.opcImp, cfg.dirLag,
           cfg.ocdRight, cfg.on1Act, cfg.opcIn, cfg.insSel, cfg.warnSetupUs, cfg.warnHoldUs,
           cfg.matL, side > 0 ? 'R' : 'L');
  say(obuf);
  if (cfg.cam2L >= 0) {
    needleName(cfg.cam2L, c2); needleName(cfg.cam2R, d2);
  } else {
    strcpy(c2, "-"); strcpy(d2, "-");
  }
  snprintf(obuf, sizeof(obuf),
           "速度 %u目/秒 (%luus/目)  OPC区間 %s..%s  2区間目 %s..%s  カーソル %s / %s  余白 %d目  選針先行 %d目  読取 ONP%s",
           cfg.sps, (unsigned long)periodUs, needleName(cfg.camL, a), needleName(cfg.camR, b), c2, d2,
           needleName(cfg.on1, n), cfg.on1b >= 0 ? needleName(cfg.on1b, n2) : "-", cfg.margin, cfg.offset, cfg.sampleRise ? "↑直前" : "↓");
  say(obuf);
  snprintf(obuf, sizeof(obuf),
           "ON1 スタート/反転パルス %s  編み出しOPCパルス %s%s  OCD遅れ %uクロック  極性 OCD右行き=%s ON1=%s OPC出力=%s INS選針=%s  キャリッジ %s端",
           cfg.on1Edge ? "あり" : "なし", cfg.opcImp ? "あり" : "なし",
           (cfg.opcImp && opcImpPending) ? "(次のパス)" : "", cfg.dirLag,
           cfg.ocdRight ? "H" : "L", cfg.on1Act ? "H" : "L", cfg.opcIn ? "H" : "L",
           cfg.insSel ? "H" : "L", side > 0 ? "右" : "左");
  say(obuf);
}

// 基準目 (×2) → "R1" / "L1〜R1の間" / "-"
static const char* refName(int16_t r2x, char* buf) {
  char a[8], b[8];
  if (r2x == NO_REF) strcpy(buf, "-");
  else if (!(r2x & 1)) needleName(r2x / 2, buf);
  else snprintf(buf, 24, "%s〜%sの間", needleName(r2x / 2, a), needleName(r2x / 2 + 1, b));
  return buf;
}
// 基準目 (×2) → "c120" / "m119.5" / "-"
static const char* refCode(int16_t r2x, char src, char* buf) {
  if (r2x == NO_REF) strcpy(buf, "-");
  else if (!(r2x & 1)) snprintf(buf, 12, "%c%d", src, r2x / 2);
  else snprintf(buf, 12, "%c%d.5", src, r2x / 2);
  return buf;
}

static void printRow(const RowRec& r) {
  char a[8], b[8];
  int16_t L = spanL(r.l1, r.l2), R = spanR(r.r1, r.l2, r.r2);
  uint32_t setup = r.st.samples ? r.st.minSetup : 0;
  if (setup > 999999UL) setup = 999999UL;
  // 人向け (X = 選針 / . = 平編み / 空白 = OPC 区間外)
  char k2c[16];
  if (r.st.k2c == NO_K2C) strcpy(k2c, "-");
  else snprintf(k2c, sizeof(k2c), "%+d目", r.st.k2c);
  snprintf(obuf, sizeof(obuf), "#%04u %s  %s..%s  選針 %u  INS変化 %u  OPC %u回 ON1 %u回  OPC↑→カーソル %s  setup>=%luus  応答<=%luus",
           r.no, r.dir > 0 ? "->R" : "L<-", needleName(L, a), needleName(R, b), r.st.sel, r.st.changes,
           r.st.opcPulses, r.st.on1Pulses, k2c, (unsigned long)setup, (unsigned long)r.st.maxLat);
  say(obuf);
  int k = 0;
  obuf[k++] = '|';
  for (int16_t i = L; i <= R; i++)
    obuf[k++] = !inWin(r.l1, r.r1, r.l2, r.r2, i) ? ' ' : getBit(r.bits, i) ? 'X' : '.';
  obuf[k++] = '|';
  obuf[k] = 0;
  say(obuf);
  {
    char q1[28], q2[28];
    snprintf(obuf, sizeof(obuf), "   基準目  区間1 %s%s  区間2 %s%s  無視したカーソル %u",
             refName(r.st.ref2x[0], q1), r.st.refSrc[0] == 'c' ? "(カーソル)" : r.st.refSrc[0] == 'm' ? "(中央)" : "",
             refName(r.st.ref2x[1], q2), r.st.refSrc[1] == 'c' ? "(カーソル)" : r.st.refSrc[1] == 'm' ? "(中央)" : "",
             r.st.ign);
    say(obuf);
  }
  if (r.st.setupViol || r.st.holdViol) {
    snprintf(obuf, sizeof(obuf), "!! setup<%uus x%u  hold<%uus x%u", cfg.warnSetupUs, r.st.setupViol,
             cfg.warnHoldUs, r.st.holdViol);
    say(obuf);
  }
  // 機械向け (bits は左→右: 1 = 選針 / 0 = 平編み / - = OPC 区間外)
  char rc1[12], rc2[12];
  k = snprintf(obuf, sizeof(obuf),
               "@ROW n=%u dir=%c l=%d r=%d l1=%d r1=%d l2=%d r2=%d sel=%u chg=%u opcp=%u on1p=%u k2c=%d "
               "ref1=%s ref2=%s ign=%u setup=%lu lat=%lu sv=%u hv=%u bits=",
               r.no, r.dir > 0 ? 'R' : 'L', L, R, r.l1, r.r1, r.l2, r.r2, r.st.sel, r.st.changes,
               r.st.opcPulses, r.st.on1Pulses, r.st.k2c, refCode(r.st.ref2x[0], r.st.refSrc[0], rc1),
               refCode(r.st.ref2x[1], r.st.refSrc[1], rc2), r.st.ign, (unsigned long)setup, (unsigned long)r.st.maxLat,
               r.st.setupViol, r.st.holdViol);
  for (int16_t i = L; i <= R && k < (int)sizeof(obuf) - 1; i++)
    obuf[k++] = !inWin(r.l1, r.r1, r.l2, r.r2, i) ? '-' : getBit(r.bits, i) ? '1' : '0';
  obuf[k] = 0;
  say(obuf);
}

#if SIM_HAS_MATRIX
static void updateMatrix() {
  memset(frame, 0, sizeof(frame));
  int16_t left = cfg.matL >= 0 ? cfg.matL : spanL(cfg.camL, cfg.cam2L);
  for (uint8_t row = 0; row < 8 && row < histCount; row++) {       // 上 = 最新
    const RowRec& rec = hist[(histHead + HIST_ROWS - 1 - row) % HIST_ROWS];
    for (uint8_t c = 0; c < 12; c++) {
      int16_t n = left + c;
      if (n >= 0 && n < NEEDLES && inWin(rec.l1, rec.r1, rec.l2, rec.r2, n) && getBit(rec.bits, n)) frame[row][c] = 1;
    }
  }
  matrix.renderBitmap(frame, 8, 12);
}
#else
static void updateMatrix() {}
#endif

// ---- INS 監視 -----------------------------------------------------------------
static void pollIns(uint32_t now) {
  bool v = readIns();
  if (v == insLast) return;
  insLast    = v;
  tInsChange = now;
  if (ph == PH_HIGH || ph == PH_LOW) {
    st.changes++;
    uint32_t lat = now - tRise;
    if (lat > st.maxLat) st.maxLat = lat;
    if (sampledInPass && (now - tSample) < cfg.warnHoldUs) st.holdViol++;
  }
}

static void sampleNeedle(uint32_t now) {
  pollIns(now);                                   // 直前の変化も拾ってから読む
  int16_t k = stepIdx - 1;
  if (k >= 0 && k < WAVE_MAX && insLast) wave[k] |= 4;
  int16_t n = selPos();
  if (!inside(n)) return;
  uint32_t setup = now - tInsChange;
  if (setup < st.minSetup) st.minSetup = setup;
  if (setup < cfg.warnSetupUs) st.setupViol++;
  st.samples++;
  tSample       = now;
  sampledInPass = true;
  if (insLast == (bool)cfg.insSel) { setBit(cur, n); st.sel++; }
}

// ---- 走行 ---------------------------------------------------------------------
static void startPass(int8_t d) {
  if (d == side) {
    say(d > 0 ? "※ 右端から右行き: キャリッジを左端へ移してから走行 (針位置の連続性なし)"
              : "※ 左端から左行き: キャリッジを右端へ移してから走行 (針位置の連続性なし)");
  }
  int16_t L = spanL(cfg.camL, cfg.cam2L), R = spanR(cfg.camR, cfg.cam2L, cfg.cam2R);
  int16_t o = cfg.offset < 0 ? -cfg.offset : cfg.offset;   // 選針位置が区間を抜けきるまで走る
  dir    = d;
  pos    = d > 0 ? L - cfg.margin - o : R + cfg.margin + o;
  endPos = d > 0 ? R + cfg.margin + o : L - cfg.margin - o;
  startPos = pos;
  memset(cur, 0, sizeof(cur));
  memset(&st, 0, sizeof(st));
  st.minSetup   = 0xFFFFFFFFUL;
  sampledInPass = false;
  stepIdx       = 0;
  opcFirst      = -1;
  curIdx        = -1;
  curN          = 0;
  memset(wave, 0, sizeof(wave));
  opcImpThis    = cfg.opcImp && opcImpPending;
  opcImpPending = false;
  passNo++;
  applyTiming();
  outRest();                                     // OCD は dirlag 目めで切り替える
  snprintf(obuf, sizeof(obuf), "@PASS n=%u dir=%c from=%d to=%d sps=%u l=%d r=%d l2=%d r2=%d on1=%d on1b=%d imp=%u",
           passNo, d > 0 ? 'R' : 'L', pos, endPos, cfg.sps, cfg.camL, cfg.camR, cfg.cam2L, cfg.cam2R,
           cfg.on1, cfg.on1b, opcImpThis ? 1 : 0);
  say(obuf);
  tStep = micros() + cfg.leadUs;                 // 表示を済ませてから lead を数える
  ph    = PH_LEAD;
}

static void stepRise(uint32_t now) {
  int16_t k  = stepIdx++;
  bool edge  = (k == cfg.dirLag);                         // OCD を切り替えるクロック
  if (edge) outOcd(dir);
  bool win    = inside(selPos());
  bool cursor = (pos == cfg.on1) || (cfg.on1b >= 0 && pos == cfg.on1b);
  if (win && opcFirst < 0) opcFirst = k;
  if (cursor && curIdx < 0) curIdx = k;
  if (cursor && curN < CUR_MAX) { curSel[curN] = selPos(); curWin[curN] = winOf(selPos()); curN++; }
  outOpc(win || (edge && opcImpThis));                    // 編み出しパルス = 1 目ぶん H
  outOn1(cursor || (edge && cfg.on1Edge));                // スタート/反転パルス = 1 目ぶん L
  outOnp(true);
  if (k < WAVE_MAX) {                                     // ピンに出したレベルを記録
    bool opcH = opcOut ? cfg.opcIn : !cfg.opcIn;
    bool on1H = on1Out ? cfg.on1Act : !cfg.on1Act;
    wave[k] = (uint8_t)((opcH ? 1 : 0) | (on1H ? 2 : 0) | (ocdLevel ? 8 : 0));
  }
  tRise = now;
  ph    = PH_HIGH;
}

static void printWave() {
  int k = snprintf(obuf, sizeof(obuf), "@WAVE n=%u dir=%c from=%d k=%d d=", passNo, dir > 0 ? 'R' : 'L',
                   startPos, stepIdx);
  for (int16_t i = 0; i < stepIdx && i < WAVE_MAX && k < (int)sizeof(obuf) - 1; i++)
    obuf[k++] = "0123456789ABCDEF"[wave[i] & 15];
  obuf[k] = 0;
  say(obuf);
}

static void endPass() {
  outRest();
  side = dir;
  RowRec& r = hist[histHead];
  r.no  = passNo;
  r.dir = dir;
  r.l1  = cfg.camL;  r.r1 = cfg.camR;
  r.l2  = cfg.cam2L; r.r2 = cfg.cam2R;
  st.k2c = (opcFirst >= 0 && curIdx >= 0) ? (int16_t)(curIdx - opcFirst) : NO_K2C;
  // 基準目: 区間内で最初のカーソルパルス、なければ区間の中央。区間外のパルスは無視
  uint8_t used = 0;
  for (uint8_t w = 0; w < 2; w++) {
    int16_t a = w ? cfg.cam2L : cfg.camL, b = w ? cfg.cam2R : cfg.camR;
    st.ref2x[w] = NO_REF; st.refSrc[w] = '-';
    if (a < 0) continue;
    for (uint8_t i = 0; i < curN; i++) {
      if (curWin[i] == w + 1) { st.ref2x[w] = (int16_t)(curSel[i] * 2); st.refSrc[w] = 'c'; used++; break; }
    }
    if (st.refSrc[w] == '-') { st.ref2x[w] = (int16_t)(a + b); st.refSrc[w] = 'm'; }
  }
  st.ign = (uint8_t)(curN - used);
  r.st  = st;
  memcpy(r.bits, cur, sizeof(cur));
  histHead = (histHead + 1) % HIST_ROWS;
  if (histCount < HIST_ROWS) histCount++;
  printRow(r);
  printWave();
  updateMatrix();

  bool more = false;
  if (autoOn) {
    if (autoInf) more = true;
    else if (autoLeft > 1) { autoLeft--; more = true; }
  }
  if (more) {
    tPause = micros() + (uint32_t)cfg.pauseMs * 1000UL;
    ph     = PH_PAUSE;
  } else {
    autoOn = false;
    ph     = PH_IDLE;
    say(side > 0 ? "@IDLE side=R" : "@IDLE side=L");
  }
}

static void stopSim() {
  bool running = (ph == PH_LEAD || ph == PH_HIGH || ph == PH_LOW);
  outRest();
  autoOn = false;
  if (running) {
    snprintf(obuf, sizeof(obuf), "@ABORT n=%u (この段は記録しない)", passNo);
    say(obuf);
    passNo--;
    if (opcImpThis) opcImpPending = true;        // 編み出しパルスは次のパスでやり直す
  }
  ph = PH_IDLE;
  say(side > 0 ? "@IDLE side=R" : "@IDLE side=L");
}

static void runSim(uint32_t now) {
  switch (ph) {
    case PH_IDLE:
      break;
    case PH_PAUSE:
      if (due(now, tPause)) startPass((int8_t)-side);
      break;
    case PH_LEAD:
      if (due(now, tStep)) stepRise(now);
      break;
    case PH_HIGH:
      if (due(now, tStep + highUs)) {
        if (!cfg.sampleRise) sampleNeedle(now);
        outOnp(false);
        ph = PH_LOW;
      }
      break;
    case PH_LOW:
      if (due(now, tStep + periodUs)) {
        if (cfg.sampleRise) sampleNeedle(now);
        if (pos == endPos) { endPass(); break; }
        pos += dir;
        // 1 周期以上遅れたら詰め込まずに今から数え直す
        if ((int32_t)(now - (tStep + periodUs)) > (int32_t)periodUs) tStep = now;
        else tStep += periodUs;
        stepRise(now);
      }
      break;
  }
}

static void startAuto(uint16_t n) {
  autoOn   = true;
  autoInf  = (n == 0);
  autoLeft = n;
  if (ph == PH_IDLE) startPass((int8_t)-side);
}

// ---- コマンド ------------------------------------------------------------------
static void printHelp() {
  say("SRCarriageSim " SIM_VERSION "  — Silver Reed 電子キャリッジ シミュレータ");
  say(" p            1パス (前回と逆向き)      r / l   右行き / 左行き 1パス");
  say(" a [N]        自動往復 N パス (省略=無制限)  s  停止");
  say(" init         編み出しからやり直す (履歴を消し、次のパスで OPC 編み出しパルス)");
  say(" speed N      速度 [目/秒] 1..2000");
  say(" cam A B [C D]  ポイントカム 2 個か 4 個 (順不問)。並べて 1-2 番目 = OPC 区間 1、3-4 番目 = 区間 2");
  say(" cam2 A B | cam2 off   ポイントカム 3・4 だけ変える / なくす");
  say(" on1 A [B|off]  カーソル 1 つか 2 つ (順不問)");
  say(" on1edge 0|1  スタート/反転時の ON1 パルス   opcimp 0|1  編み出し時の OPC パルス");
  say(" offset N     選針位置の先行 [目] (OPC 区間と記録が進行方向へ N 目先)  -60..60");
  say(" dirlag N     動き始めてから OCD を切り替えるまでの ONP 数 0..20");
  say(" margin N     区間外側の走行目数");
  say(" sample fall|rise  INS を読む時点 (ONP↓ / 次の ONP↑ 直前)");
  say(" duty N  pause N[ms]  lead N[us]  warn setup hold[us]");
  say(" pol ocd|on1|opc|ins 0|1   (既定は実機どおり: ocd 0 on1 0 opc 1 ins 0)");
  say(" (旧名 nd1 / nd1edge / kslimp / pol hok|nd1|ksl|dob も使える)");
  say(" mat N|off    LED マトリクス左端針 (UNO R4 WiFi)");
  say(" hist [N]  clear  cfg  save  load  default");
}

static bool busy() { return ph == PH_LEAD || ph == PH_HIGH || ph == PH_LOW; }

static void handleCommand(char* s) {
  char* argv[6] = { nullptr, nullptr, nullptr, nullptr, nullptr, nullptr };
  int argc = 0;
  for (char* t = strtok(s, " \t"); t && argc < 6; t = strtok(nullptr, " \t")) argv[argc++] = t;
  if (!argc) return;
  for (char* p = argv[0]; *p; p++) *p = (char)tolower((unsigned char)*p);
  const char* c = argv[0];
  long v = 0;

  if (!strcmp(c, "s") || !strcmp(c, "stop")) { stopSim(); return; }
  if (busy() && strcmp(c, "cfg") && strcmp(c, "?") && strcmp(c, "help")) {
    say("走行中です (s で停止)");
    return;
  }
  bool changed = false;

  if (!strcmp(c, "?") || !strcmp(c, "help")) { printHelp(); return; }
  else if (!strcmp(c, "p")) { autoOn = false; startPass((int8_t)-side); return; }
  else if (!strcmp(c, "r")) { autoOn = false; startPass(1); return; }
  else if (!strcmp(c, "l")) { autoOn = false; startPass(-1); return; }
  else if (!strcmp(c, "a")) {
    if (argc > 1 && !parseLong(argv[1], 0, 60000, &v)) { say("a [N]  N=0..60000 (0=無制限)"); return; }
    startAuto((uint16_t)v);
    return;
  }
  else if (!strcmp(c, "init")) {
    autoOn = false; ph = PH_IDLE;
    histCount = 0; histHead = 0; passNo = 0;
    opcImpPending = true;
    updateMatrix();
    say("@CLEAR");
    say("編み出しからやり直します (次のパスで OPC 編み出しパルス)");
    return;
  }
  else if (!strcmp(c, "speed")) {
    if (argc < 2 || !parseLong(argv[1], SPS_MIN, SPS_MAX, &v)) { say("speed 1..2000 [目/秒]"); return; }
    cfg.sps = (uint16_t)v; changed = true;
  }
  else if (!strcmp(c, "cam") || !strcmp(c, "cam2")) {
    // ポイントカム: cam A B [C D] (2 個か 4 個、順不問) / cam2 A B | cam2 off (3・4 個目だけ)
    int16_t p[4];
    int n = 0;
    bool ok = true;
    if (!strcmp(c, "cam2")) {
      if (argc == 2 && !strcmp(argv[1], "off")) { cfg.cam2L = -1; cfg.cam2R = -1; applyTiming(); printCfg(); return; }
      p[n++] = cfg.camL; p[n++] = cfg.camR;
      if (argc != 3) ok = false;
    } else if (argc != 3 && argc != 5) ok = false;
    for (int i = 1; ok && i < argc; i++) ok = parseNeedle(argv[i], &p[n++]);
    if (ok) {
      for (int i = 1; i < n; i++)                       // 針番号順に並べる
        for (int j = i; j > 0 && p[j - 1] > p[j]; j--) { int16_t t = p[j]; p[j] = p[j - 1]; p[j - 1] = t; }
      for (int i = 1; i < n; i++) if (p[i] == p[i - 1]) ok = false;   // 同じ針に 2 つは置けない
    }
    if (!ok) { say(c[3] == '2' ? "cam2 <針> <針> | cam2 off" : "cam <針> <針> [<針> <針>]  ポイントカム 2 個か 4 個 (順不問)  例: cam L30 R30"); return; }
    cfg.camL = p[0]; cfg.camR = p[1];
    if (n == 4) { cfg.cam2L = p[2]; cfg.cam2R = p[3]; } else { cfg.cam2L = -1; cfg.cam2R = -1; }
    changed = true;
  }
  else if (!strcmp(c, "on1") || !strcmp(c, "nd1")) {
    // カーソル: on1 A [B|off] (1 つか 2 つ、順不問。旧名 nd1 も可)
    int16_t a, b = -1;
    bool ok = argc >= 2 && argc <= 3 && parseNeedle(argv[1], &a);
    if (ok && argc == 3 && strcmp(argv[2], "off")) ok = parseNeedle(argv[2], &b);
    if (!ok) { say("on1 <針> [<針>|off]  カーソル 1 つか 2 つ  例: on1 R1 / on1 L20 R20"); return; }
    cfg.on1 = a; cfg.on1b = b; changed = true;
  }
  else if (!strcmp(c, "on1edge") || !strcmp(c, "opcimp") || !strcmp(c, "nd1edge") || !strcmp(c, "kslimp")) {
    bool edgeCmd = !strcmp(c, "on1edge") || !strcmp(c, "nd1edge");   // 旧名 nd1edge / kslimp も可
    if (argc < 2 || !parseLong(argv[1], 0, 1, &v)) { say(edgeCmd ? "on1edge 0|1" : "opcimp 0|1"); return; }
    if (edgeCmd) cfg.on1Edge = (uint8_t)v; else cfg.opcImp = (uint8_t)v;
    changed = true;
  }
  else if (!strcmp(c, "margin")) {
    if (argc < 2 || !parseLong(argv[1], 1, 60, &v)) { say("margin 1..60"); return; }
    cfg.margin = (int16_t)v; changed = true;
  }
  else if (!strcmp(c, "offset")) {
    if (argc < 2 || !parseLong(argv[1], -60, 60, &v)) { say("offset -60..60"); return; }
    cfg.offset = (int16_t)v; changed = true;
  }
  else if (!strcmp(c, "dirlag")) {
    if (argc < 2 || !parseLong(argv[1], 0, 20, &v)) { say("dirlag 0..20"); return; }
    cfg.dirLag = (uint8_t)v; changed = true;
  }
  else if (!strcmp(c, "sample")) {
    if (argc < 2 || (strcmp(argv[1], "fall") && strcmp(argv[1], "rise"))) { say("sample fall|rise"); return; }
    cfg.sampleRise = !strcmp(argv[1], "rise"); changed = true;
  }
  else if (!strcmp(c, "duty")) {
    if (argc < 2 || !parseLong(argv[1], 5, 95, &v)) { say("duty 5..95 [%]"); return; }
    cfg.duty = (uint8_t)v; changed = true;
  }
  else if (!strcmp(c, "pause")) {
    if (argc < 2 || !parseLong(argv[1], 0, 60000, &v)) { say("pause 0..60000 [ms]"); return; }
    cfg.pauseMs = (uint16_t)v; changed = true;
  }
  else if (!strcmp(c, "lead")) {
    if (argc < 2 || !parseLong(argv[1], 0, 60000, &v)) { say("lead 0..60000 [us]"); return; }
    cfg.leadUs = (uint16_t)v; changed = true;
  }
  else if (!strcmp(c, "warn")) {
    long h = 0;
    if (argc < 3 || !parseLong(argv[1], 0, 60000, &v) || !parseLong(argv[2], 0, 60000, &h)) {
      say("warn <setup_us> <hold_us>"); return;
    }
    cfg.warnSetupUs = (uint16_t)v; cfg.warnHoldUs = (uint16_t)h; changed = true;
  }
  else if (!strcmp(c, "pol")) {
    if (argc < 3 || !parseLong(argv[2], 0, 1, &v)) { say("pol ocd|on1|opc|ins 0|1"); return; }
    for (char* p = argv[1]; *p; p++) *p = (char)tolower((unsigned char)*p);
    const char* k = argv[1];                     // 旧名 hok / nd1 / ksl / dob も可
    if      (!strcmp(k, "ocd") || !strcmp(k, "hok")) cfg.ocdRight = (uint8_t)v;
    else if (!strcmp(k, "on1") || !strcmp(k, "nd1")) cfg.on1Act   = (uint8_t)v;
    else if (!strcmp(k, "opc") || !strcmp(k, "ksl")) cfg.opcIn    = (uint8_t)v;
    else if (!strcmp(k, "ins") || !strcmp(k, "dob")) cfg.insSel   = (uint8_t)v;
    else { say("pol ocd|on1|opc|ins 0|1"); return; }
    outRest();
    outOcd(side > 0 ? 1 : -1);
    changed = true;
  }
  else if (!strcmp(c, "mat")) {
    int16_t a;
    if (argc >= 2 && !strcmp(argv[1], "off")) cfg.matL = -1;
    else if (argc >= 2 && parseNeedle(argv[1], &a)) cfg.matL = a;
    else { say("mat <針>|off"); return; }
    updateMatrix();
    changed = true;
  }
  else if (!strcmp(c, "hist")) {
    long n = 8;
    if (argc > 1 && !parseLong(argv[1], 1, HIST_ROWS, &n)) { say("hist 1..64"); return; }
    if (n > histCount) n = histCount;
    for (long i = n - 1; i >= 0; i--) printRow(hist[(histHead + HIST_ROWS - 1 - i) % HIST_ROWS]);
    if (!histCount) say("(履歴なし)");
    return;
  }
  else if (!strcmp(c, "clear")) {
    histCount = 0; histHead = 0; passNo = 0;
    updateMatrix();
    say("@CLEAR");
    return;
  }
  else if (!strcmp(c, "cfg")) { printCfg(); return; }
  else if (!strcmp(c, "save")) { saveConfig(); say("保存しました"); return; }
  else if (!strcmp(c, "load")) {
    say(loadConfig() ? "読み込みました" : "保存された設定がありません");
    printCfg();
    return;
  }
  else if (!strcmp(c, "default")) { setDefaults(); changed = true; }
  else { say("? でコマンド一覧"); return; }

  if (changed) { applyTiming(); printCfg(); }
}

static void pollSerial() {
  while (Serial.available() > 0) {
    int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\r' || ch == '\n') {
      if (lineLen) { line[lineLen] = 0; handleCommand(line); lineLen = 0; }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = (char)ch;
    }
  }
}

// 押した瞬間だけ true (30ms デバウンス)
static bool pressed(Button& b, uint32_t ms) {
  bool v = digitalRead(b.pin) == HIGH;
  if (v != b.last) { b.last = v; b.tChange = ms; }
  if (ms - b.tChange >= 30 && v != b.stable) { b.stable = v; return !v; }
  return false;
}

static void pollButtons() {
  uint32_t ms = millis();
  if (pressed(btnPass, ms) && !busy()) { autoOn = false; startPass((int8_t)-side); }
  if (pressed(btnAuto, ms)) {
    if (autoOn) stopSim();
    else if (!busy()) startAuto(0);
  }
}

// ---- Arduino ------------------------------------------------------------------
void setup() {
  pinMode(PIN_ONP, OUTPUT);
  pinMode(PIN_OCD, OUTPUT);
  pinMode(PIN_OPC, OUTPUT);
  pinMode(PIN_ON1, OUTPUT);
  pinMode(PIN_OPC_LED, OUTPUT);
  pinMode(PIN_INS, INPUT_PULLUP);
  pinMode(PIN_BTN_PASS, INPUT_PULLUP);
  pinMode(PIN_BTN_AUTO, INPUT_PULLUP);

  setDefaults();
  bool loaded = loadConfig();
  applyTiming();
  outRest();
  outOcd(side > 0 ? 1 : -1);
  insLast    = readIns();
  tInsChange = micros();

  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1500) {}
#if SIM_HAS_MATRIX
  matrix.begin();
  updateMatrix();
#endif
  printHelp();
  say(loaded ? "(保存された設定を読み込みました)" : "(既定の設定)");
  printCfg();
  say("@IDLE side=R");
}

void loop() {
  uint32_t now = micros();
  pollIns(now);
  runSim(now);
  pollSerial();     // 走行中は s / cfg / ? だけ受け付ける
  pollButtons();
}
