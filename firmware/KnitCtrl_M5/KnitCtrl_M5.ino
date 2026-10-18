/* =============================================================================
 *  編み機コントロール WebSocket サーバ  (M5Stack Core2 / CoreS3)  ― キャリッジ制御・多色編み対応
 *  Knitting Machine Control — WebSocket Server for M5Stack Core2 / CoreS3 (carriage control, multi-color, proto v3)
 * -----------------------------------------------------------------------------
 *  対向: 「SRパタコン」編み機コントロール (ブラウザ = WS クライアント)
 *  役割: シルバーリード電子キャリッジの信号を読み、SRパタコンから 1 パスずつ受け取ったパターンで
 *        選針する。最初に空通し (往復) でポイントカムとカーソルの位置を確かめてから編み込みに入る。
 *        各フレームにプロトコル通り応答:
 *          MODE_ENTER → READY / ROW_DATA → ACK (そのパスを編み終えたとき) / STOP → STOPPED /
 *          HELLO → INFO / CALIB → 空通しの案内を始める / 状態が変わるたびに STATUS を送る
 *
 *  対象機種: M5Stack Core2 と CoreS3 (CoreS3 Lite / CoreS3 SE を含む)。
 *  キャリッジの信号の名前 (rev.43、2026-10-17 に改めた。カッコ内は旧称。O = キャリッジから出る / I = キャリッジへ入る):
 *    OCD = キャリッジ方向 (旧 HOK)、ONP = 編み目カウント (旧 CCP)、OPC = ポイントカム有効区間 (旧 KSL)、
 *    ON1 = カーソル (旧 ND1)、INS = 選針 (旧 DOB)
 *  キャリッジのコネクタ (DIN 7 ピン メス ⇔ XH 8 ピン、ケーブル色。2026-10-17):
 *    ON1 = DIN 1 / XH 6 (赤)、OCD = DIN 2 / XH 7 (灰)、INS = DIN 3 / XH 8 (橙)、ONP = DIN 4 / XH 4 (青)、
 *    OPC = DIN 5 / XH 5 (黒)、16V = DIN 6 / XH 3 (黄)、Vcc 5V = DIN 7 / XH 1 (白)、GND = キー / XH 2 (緑)
 *  M5キャリコンの GPIO の記号 (rev.44、2026-10-17): M5 から見た向きで I / O を付け替える
 *  (I = M5 へ入る / O = M5 から出る)。キャリッジとキャリッジシミュレータは上の OCD・ONP・OPC・ON1・INS のまま。
 *    ICD = キャリッジの OCD、INP = ONP、IPC = OPC、IN1 = ON1、ONS = INS
 *  キャリッジの配線 (仕様書 6.9.1。M5-Bus の同じピン番号で、GPIO 番号が機種で違う):
 *    記号 (キャリッジ側)  向き   M5-Bus      Core2  CoreS3  論理
 *    ONS (INS) 選針       出力   16 (R16)    G14    G17     L (GND) = 選針 / H (5V) = 平編み (キャリッジの INS と同じ。rev.46)
 *    INP (ONP)            入力   15 (L16)    G13    G18     L→H の立ち上がりで 1 目進む (針パルス)
 *    ICD (OCD)            入力   21 (L21)    G27    G6      H = 左へ (左←右) / L = 右へ (左→右)
 *    IN1 (ON1)            入力    4 (R4)     G36    G8      L パルス = カーソル (パターン 1 目の基準針) を通過。
 *                                                           キャリッジのスタート時と反転時にも出る
 *    IPC (OPC)            入力   22 (R22)    G19    G7      H = パターンを選針に出す区間 (PC1→PC2、PC3→PC4) /
 *                                                           L = 平編み。最初の編み出し時にパルスが出る
 *    ・Core2 の G36 は入力専用でプルアップがない。インタフェース側で H に保つこと。
 *      ESP32 の G36 は WiFi 動作中に短いグリッチで割り込みが入ることがあるので、割り込みの中で
 *      読み直して L のときだけカーソルとする (INP の時点のレベルでも拾う)。
 *      1 つの L パルスは 1 回だけ数える: 直前の INP の時点ですでに L だったパルスには IN1 の割り込みで
 *      印を付けない (Core2 で IN1 と INP の端がほぼ同時に来たときの二重カウントを防ぐ。仕様書 6.9.2)。
 *    ・CoreS3 の G17/G18 はポート C (UART)、G8 はポート B と同じピン。そのポートには何もつながないこと。
 *    ・ONS の論理は INS と同じ L (GND) = 選針 / H (5V) = 平編み (ONS_ACTIVE_HIGH = false。rev.46 で訂正。
 *      rev.45 までは H = 選針で出していた)。起動時は出力にする前に H (平編み) を出力レジスタに入れておき、
 *      出力にした瞬間に L (選針) を出さない。電源を入れてから setup までは M5 が ONS を駆動しないので、
 *      インタフェース側で H (平編み) にプルアップしておくこと。
 *    ・それ以外の機種はキャリッジを使わない表示専用で動く (下の CARRIAGE_ENABLE と同じ)。
 *  電源: M5 は M-Bus の 5V (28 番ピン) からインタフェース基板と共有で受ける (MBUS_5V_INPUT)。
 *    本体から M-Bus へ 5V を出す回路 (Core2 の昇圧 / CoreS3 の BUS_OUT) は起動時に切り、
 *    外から入る 5V とぶつからないようにする (M5Unified の cfg.output_power = false)。
 *    書き込みで USB をつなぐときは、基板の 5V と USB の 5V が同時に入らないよう、基板側の 5V を切るか
 *    5V を通さない USB ケーブルを使う (Core2 v1.1 は出力を切ると USB の 5V と M-Bus の 5V が本体内でつながる)。
 *    基板の 5V 電源は M5 本体の消費 (WiFi・LCD・音声) も見込んだ容量にする。
 *
 *  空通し (仕様書 6.9.3): SRパタコンの「空通し」(または本体の A ボタン) で始める。
 *    開始側 (右端 / 左端) は SRパタコンで選ぶ (本体の B ボタンでも切り替え、NVS に保存)。
 *    右端からなら 左へ → 右へ の往復。LCD と音声でキャリッジの置き場所と動かす向きを案内する。
 *    ・往復それぞれで、IPC の変化 (= ポイントカム) とカーソル (IN1) を INP で数える。
 *      INP のカウントは走り始めの位置で変わるので、カーソルを 0 とした相対値で扱う。
 *    ・IPC を判定する位置と IN1 を判定する位置の差 (先行) は片道では決まらないので、同じポイントカムを
 *      往路・復路の両側から通ったカウントから求める。すべてのポイントカムで同じ先行になり、往復で
 *      ポイントカムの数とカーソル (各 1 回) がそろえば完了。そろわなければ表示と音声でやり直しを案内する。
 *    ・ポイントカムは往路で出会った順に PC1..PC4。PC1–PC2 / PC3–PC4 が選針区間。
 *      PC3 だけで PC4 がない (IPC が下がらない) ときは PC3 を無視し、PC1–PC2 だけで選針する。
 *      PC1・PC2 がなければパターンを出せないので、不一致として扱う。
 *  編み込み (仕様書 6.9.4): 空通しが済んだら SRパタコンのスタート / ストップを待つ。送信が始まったら
 *    音声で編み込み開始とキャリッジを動かす向きを案内し、LCD に向き・段とパス・目数を出す。
 *    ・各トラバース (1 方向の移動) の IPC の変化とカーソルを空通しの記録に合わせて、選針位置の針を
 *      カーソル基準で求め、選針区間の中で受け取ったパスのビットを出す (カーソル = 目1 から左右へ繰り返す)。
 *    ・最後の区間を抜けたら ACK を返し、次のパスを受け取る。縦2倍は同じパスで 2 回編んでから ACK。
 *    ・データが届く前に区間へ入った / 区間の途中で折り返した / 位置がずれた ときは音声で知らせる。
 *
 *  音声: SD カードの /voice/NN.wav (NN = VOICE_TEXT の番号、16bit PCM) を鳴らす。ファイルがなければブザー音。
 *
 *  SRパタコンとのリンク (rev.42): 送信相手は応答 (ping への pong) が 10 分 (LINK_TIMEOUT_MS) 途絶えるまで
 *    つないだままにする (糸処理などでタブレットがスリープしても切らない)。10 分で切ったとき、または
 *    BYE なしで切れて 10 分つなぎ直さないときは音声 24 で警告する。SRパタコンの「切断」・本体の A+C で
 *    「SRパタコン接続待ち」になったら音声 23 で知らせる。
 *
 *  多色編み (仕様書 4.3.5 / 6.3):
 *    ・1 デザイン段 = N パス。2色は 1パス、3色以上は色数ぶんのパスで、最終パスが地色(色番号0)。
 *      パス p(p<N) は色番号 p の目を選針する。2パスは存在しない (N = 1, 3..8)。
 *    ・N は MODE_ENTER [6]、パレットは [7..30]、各段のパス番号/色番号は ROW_DATA 末尾で受け取る。
 *      受け取ったパス番号/色番号は段位置 (添字 mod N と送り方向) から求めた値と照合し、
 *      食い違えば NAK(code 3) を返して転送を止める (違う糸で編まないため)。
 *    ・送出はデザイン段ごとに必ず パス1→パスN の順 (アプリ側で保証)。
 *    ・縦2倍 (KF_V2) は受け取ったパスを 2 回編んでから ACK: パス1×2 → パス2×2 … → パスN×2。
 *    ・LCD はパスを重ねた合成図 (編み上がりの見た目) を描き、右上に今のパスの糸色を大きく出す。
 *      1 マーク 2×2 px。161マーク以上は全体が入らないので 1×1 px に落とす (320マークまで)。
 *      横2倍では 1 目 = 2 マークなので、81目以上で 1×1 px になる。
 *      2色・多色ともアプリから受け取った糸色でそのまま塗る (2色は選針目 = 色1 / 地 = 色0)。
 *    ・v1 クライアント (追記なし) からのフレームも受け付ける (N = 1 / 内蔵の既定色 = 白地に黒マーク)。
 *
 *  必要ライブラリ (Arduino IDE ライブラリマネージャ):
 *    - M5Unified                              (M5Stack)
 *    - WebSockets  by Markus Sattler          → <WebSocketsServer.h>
 *    (SD / Preferences / WebServer / DNSServer は ESP32 コアに同梱)
 *  対応ボード: M5Stack Core2 / CoreS3 (CoreS3 Lite・SE を含む)。ボードは Arduino IDE で M5Core2 / M5CoreS3 を選ぶ。
 *    それ以外の機種はキャリッジを使わない表示専用 (従来どおり即 ACK / proto v2)。
 *  パーティション: プログラムは約 1.8MB (日本語フォントを含む)。Core2・CoreS3 とも既定 (Core2 6.5MB APP /
 *    CoreS3「16M Flash (3MB APP/9.9MB FATFS)」) で入る。1.2MB APP の設定 (Default 4MB 等) では入らないので、
 *    そのときは Partition Scheme を「16M Flash (3MB APP/9.9MB FATFS)」か「Huge APP (3MB No OTA)」にする。
 *
 *  WiFi 設定 (コンパイル後に設定する):
 *    ・SD カードの /wifi.cnf (平文) から読む。1行目 = SSID、2行目 = パスワード。
 *        例)  MyHomeWiFi
 *             mypassword123
 *      行末の CR/LF と先頭の UTF-8 BOM は無視。パスワード行がなければオープン。
 *    ・wifi.cnf がない (SD なしを含む) / 形式が不正なら SSID "SilverReed" / パスワード "12345678"。
 *    ・設定ポータルで保存した接続先 (NVS) があれば、それを先に試す。wifi.cnf の内容を書き換えたら
 *      (前回読んだ内容と違えば) NVS の接続先は消して wifi.cnf を使う = 最後に設定したほうが有効。
 *    ・接続を 5 回試しても繋がらなければ設定ポータル (候補が 2 つなら交互に試す)。
 *      ポータルを 5分放置すると再起動して接続を再試行する。
 *    ・手動でポータル: 起動時に A ボタン押したまま / 動作中に C ボタン 2秒 / シリアルで "setup"。
 *    ポータル: 本体が AP「KnitCtrl-XXXX」になり、LCD にパスワードと QR コードを出す。
 *      スマホ/PC で接続すると設定ページが開く (開かなければ http://192.168.4.1)。
 *      一覧から SSID を選び、パスワードとホスト名を入れて保存 → NVS に保存して再起動・接続する。
 *
 *  本体のボタン: A = 空通しを始める / B = 空通しの開始側 (右端⇔左端) / C 長押し = WiFi 設定ポータル /
 *    A と C の同時長押し = SRパタコンとのリンクを切る (切断要求 [85] を送り「SRパタコン接続待ち」にする。rev.37)。
 *    A は離したときに働く (C と同時に押したときは働かない)。
 *    「SRパタコン接続待ち」の画面では B = 音声の音量を下げる / C = 音量を上げる (C は短く押して離したとき。
 *    長押しは従来どおり WiFi 設定ポータル)。音量は 1〜10 の 10 段階で NVS に保存し、電源を切っても残す (rev.41)。
 *    Core2 は画面の下 (赤い丸) のタッチボタン。CoreS3 は物理ボタンがないので、画面の下 24px を
 *    左・中・右の 3 つに分けたタッチボタン (A・B・C) にし、名前を表示する。
 *  ★ 実機で確かめていない前提は定数で変えられる: STITCH_RIGHTWARD (目番号の向き)、SEL_ADJ (選針の補正)、
 *    ONS_ACTIVE_HIGH (選針出力の論理)。
 * ========================================================================== */

#include <M5Unified.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebSocketsServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <SPI.h>
#include <SD.h>
#include "soc/gpio_reg.h"   // 割り込みの中で GPIO を直接読み書きする

// ---- 型定義 -------------------------------------------------------------------
// ※ 関数より前に置くこと。Arduino IDE は .ino の関数宣言 (プロトタイプ) を最初の関数の直前へ
//   自動で挿入するため、引数に使う型がそれより後ろにあると「does not name a type」になる。

// WiFi 設定 (NVS: ポータルで保存した接続先とホスト名)
struct NetConfig {
  char ssid[33];   // 最大32バイト (空 = 保存なし)
  char pass[64];   // WPA2: 8..63 文字 / オープンは空
  char host[33];   // 英小文字・数字・ハイフン
};

// WiFi 設定 (SD: /wifi.cnf)
enum SdWifiState { SDW_NO_CARD, SDW_NO_FILE, SDW_OK, SDW_BAD };
struct SdWifi {
  SdWifiState state;
  char     ssid[33];
  char     pass[64];
  uint32_t sig;      // 内容の指紋 (書き換え検出用)
};

// 接続候補
struct WifiCand { const char* ssid; const char* pass; const char* src; };

// キャリッジの配線 (GPIO 番号。-1 = なし)
struct IoPins { int8_t ons, inp, icd, in1, ipc; };

// 割り込みと共有する値の写し (表示と STATUS 用)
struct Snap {
  uint8_t ph, err, warn, nwin, pc3, ncam, ok;
  int8_t  dir, lastDir, expDir, outDir;
  int16_t k, off, lo[2], hi[2], cam[4];
  uint16_t trav;
  int16_t recN; uint8_t recE, recC;
  int16_t q; uint8_t qOk;          // キャリッジ (選針位置) の針位置 (カーソル基準) と、それが分かっているか
  uint8_t curN[2], curOvf[2];      // 空通しで検知したカーソルの数 ([0] 往路 / [1] 復路。4 まで) と、5 つ以上あったか
  int16_t curRel[2][3];            // 2 つめ以降のカーソル: その向きで最初に検知したカーソルから進行方向へ何目あとか
};

// ==== CARRIAGE ENGINE BEGIN ==================================================
/* キャリッジ制御エンジン (仕様書 6.9)。
   INP↑ (1目進んだ) ごとに割り込みから step() を呼び、空通しの記録と編成中の選針を行う。
   Arduino の API を使わないので、ホストの g++ で単体テストできる (CE_ISR を空に定義して切り出す)。

   座標 (すべて「カーソル基準」):
     j = カーソルの IN1 パルスを 0 とした、このトラバースの INP カウント (進むほど +)。
     q = 選針位置の針番号。カーソルの針 (= パターンの目1) を 0、右を + とする。
         q = 向き × (j + 先行)。向き: 左へ = −1 / 右へ = +1。
     先行 (off) = IPC を判定する位置 (選針位置) が、IN1 を判定する位置より進行方向へ何目先にあるか。
         片道だけでは決まらないので、往復の空通しで同じポイントカムを両側から通ったときの
         カウントから求める: off = −(t往 + t復) / 2 (t は下の tval)。
   ポイントカム: IPC の変化 (↑ / ↓) 1 つが 1 個のポイントカム。往路で出会った順に PC1, PC2, PC3, PC4。
     PC1–PC2 / PC3–PC4 が選針区間。奇数個 (PC4 が見つからず IPC が下がらない) なら最後の 1 個は無視。
   ★ 実機で確かめていない前提 (調整用の定数あり):
     ・ポイントカムの針は区間に含まれる (↑ の針が最初の H、↓ の 1 つ前の針が最後の H)。
     ・目番号はカーソルから右へ増える (stitchRight)。選針位置の補正は selAdj。 */
#ifndef CE_ISR
#define CE_ISR IRAM_ATTR
#endif

namespace ce {

static const int MAX_EDGE    = 12;  // 1 パスで記録する IPC の変化の数 (ポイントカム 4 個 + 余裕)
static const int MAX_CUR     = 4;   // 1 パスで記録するカーソル (IN1) の数
static const int MAX_CAM     = 4;   // ポイントカムの最大数
static const int MAX_WIN     = 2;   // 選針区間の最大数 (PC1–PC2 / PC3–PC4)
static const int ROW_BYTES_CE = 30; // 240目 / 8
static const int IN1_GUARD    = 3;   // 走り始め (ICD 切替) からこの目数未満の IN1 と IPC↑ は
                                    //   スタート・反転パルス / 編み出しパルスとして扱う
static const int MIN_SEG     = 2;   // これより短い IPC の H は無視 (ノイズ)
static const int OFF_TOL     = 1;   // ポイントカムごとに求めた先行のばらつきの許容 (目)
static const int OFF_MAX     = 80;  // 先行の絶対値の上限 (目)
static const int SYNC_TOL    = 2;   // 編成中、基準 (IPC の変化・カーソル) と数えた位置の差の許容 (目)
static const int WRONG_DIR_N = 8;   // 空通しの最初に逆向きへこの目数動いたら「向きが違う」

// 段階 (STATUS [1])。PH_EVAL は割り込みが記録を終えて loop の判定待ち (外には復路として見せる)
enum : uint8_t { PH_UNCAL = 0, PH_PLACE = 1, PH_OUT = 2, PH_BACK = 3, PH_READY = 4, PH_KNIT = 5, PH_EVAL = 6 };
// 空通しの不一致の理由 (STATUS [6] のビット)
enum : uint8_t { E_NO_CURSOR = 1, E_MULTI_CURSOR = 2, E_NO_CAM = 4, E_CAM_COUNT = 8,
                 E_TOO_MANY = 16, E_OFF = 32, E_WRONG_DIR = 64, E_OVERFLOW = 128 };
// 編成中の警告 (STATUS [7] のビット)
enum : uint8_t { W_NODATA = 1, W_PARTIAL = 2, W_SYNC = 4 };
// 割り込み → loop のイベント
enum : uint8_t { EV_NONE = 0, EV_OUT_START, EV_WRONG_DIR, EV_BACK_START, EV_CAL_END,
                 EV_TRAV, EV_BIND, EV_NODATA, EV_DONE, EV_DONE_HALF, EV_PARTIAL, EV_SYNC };

struct Edge  { int16_t cnt; uint8_t rise; };   // cnt: ↑ は最初の H の目 / ↓ は最初の L の目
struct PassRec {
  int8_t  dir;                                 // −1 = 左へ / +1 = 右へ
  int16_t n;                                   // 数えた目数
  uint8_t ne; Edge e[MAX_EDGE];
  uint8_t nc; int16_t cur[MAX_CUR];
  uint8_t ovf;                                 // 記録があふれた (IPC の変化 / カーソル)
  uint8_t curOvf;                              // カーソルが MAX_CUR を超えた (STATUS [27] で知らせる)
};
struct TEdge { int16_t j; uint8_t rise; };     // 基準テンプレート: カーソル基準のカウント
struct Tmpl  { uint8_t ne; TEdge e[MAX_EDGE]; };
struct Cal {
  uint8_t ok;
  int8_t  outDir;                              // 空通しの往路の向き
  int16_t off;                                 // 先行 (目)
  uint8_t ncam; int16_t cam[MAX_CAM];          // ポイントカムの針位置 q (PC1, PC2, ...)
  uint8_t nwin; int16_t lo[MAX_WIN], hi[MAX_WIN];
  uint8_t pc3Ignored;                          // PC3 だけあった (PC4 なし) ので無視した
  int16_t farL, farR;                          // 全区間の左端 / 右端
  Tmpl    t[2];                                // [0] 左へ / [1] 右へ のトラバースの基準
};
struct RowSlot {
  uint8_t  bits[ROW_BYTES_CE];
  int16_t  width; uint8_t h2; uint8_t repeat;  // repeat: 残りの編む回数 (縦2倍は 2)
  uint16_t row; uint8_t ctrl, pno, cno;
};
struct Ev { uint8_t type; int16_t arg; };

struct Engine {
  // 補助 (namespace 直下に関数を置くと Arduino IDE の自動プロトタイプ生成が誤ることがあるので静的メンバにする)
  static inline CE_ISR int dIdx(int d) { return d < 0 ? 0 : 1; }
  static inline CE_ISR int iabs(int v) { return v < 0 ? -v : v; }
  // ポイントカムの針に当たるカウント (カーソル基準)。↓ は 1 つ前の目が最後の H。
  static inline int tval(const Edge& e, int cur) { return (e.rise ? e.cnt : e.cnt - 1) - cur; }
  static inline int roundDiv(long a, long b) { return (int)(a >= 0 ? (a + b / 2) / b : -((-a + b / 2) / b)); }

  // ---- 設定 (setup で決める) ----
  uint8_t bit0Right   = 0;   // 1 = 目ビットの bit0 が右端 (STITCH_BIT0_AT_RIGHT)
  uint8_t stitchRight = 1;   // 1 = 目番号はカーソルから右へ増える
  int8_t  selAdj      = 0;   // 選針する針の補正 (目、進行方向へ +)
  uint8_t ipcGate     = 1;   // 1 = IPC が H の間だけ選針する (PC3 を無視したときは位置だけで判定)

  // ---- 状態 ----
  volatile uint8_t phase = PH_UNCAL;
  int8_t  expectDir = -1;    // 空通しの往路の向き
  uint8_t startSide = 0;     // 0 = 右端から / 1 = 左端から
  uint8_t err = 0, warn = 0;
  Cal     cal;
  PassRec rec[2];            // [0] 往路 / [1] 復路

  // トラバース (キャリッジの 1 方向の移動。ICD が変わったら次のトラバース)
  int8_t  dir = 0, lastDir = 0;
  int16_t k = 0;             // このトラバースで数えた目 (最初の INP = 0)
  uint8_t ipcPrev = 0, segOpen = 0;
  int16_t riseAt = 0, wrongCnt = 0;

  // 編成
  uint8_t anchored = 0, eIdx = 0, svA = 0, svE = 0;
  int16_t j = 0, svJ = 0, q = 0;
  uint8_t bound = 0, done = 0, tried = 0, seen = 0, syncSaid = 0, inWin = 0;
  uint8_t skipNext = 0, noBind = 0;   // 途中で折り返した直後のトラバースは選針しない (区間の中から出発するため)
  RowSlot slot[2];
  int8_t  armSlot = -1, curSlot = 0;
  uint16_t travDone = 0;     // 編み終えたトラバースの数 (編み込み開始から)
  uint8_t ons = 0;           // 選針出力 (1 = 選針)
  uint32_t inpTotal = 0;

  Ev ev[16]; volatile uint8_t evHead = 0, evTail = 0;

  // ---------------------------------------------------------------- 割り込み側
  CE_ISR void push(uint8_t t, int16_t a) {
    uint8_t h = evHead, nx = (uint8_t)((h + 1) & 15);
    if (nx == evTail) return;                  // あふれたら捨てる
    ev[h].type = t; ev[h].arg = a; evHead = nx;
  }

  // INP↑ ごと。icdH: 1 = 左へ (左←右) / ipcH: 1 = パターン出力区間 / in1: 前回から IN1 の L パルスがあった
  CE_ISR void step(uint8_t icdH, uint8_t ipcH, uint8_t in1) {
    inpTotal++;
    int8_t d = icdH ? -1 : 1;
    if (d != dir) beginTrav(d, ipcH); else if (k < 30000) k++;
    uint8_t cur = (in1 && k >= IN1_GUARD) ? 1 : 0;
    uint8_t ph = phase;
    if (ph == PH_PLACE)                       placeStep(d, ipcH);
    else if (ph == PH_OUT || ph == PH_BACK)   recStep(ipcH, cur);
    else if (ph == PH_READY || ph == PH_KNIT) knitStep(ipcH, cur);
    else                                      ons = 0;
    ipcPrev = ipcH;
  }

  CE_ISR void beginTrav(int8_t d, uint8_t ipcH) {
    if (dir != 0) endTrav();
    dir = d; lastDir = d; k = 0; ipcPrev = ipcH; segOpen = ipcH;
    anchored = 0; eIdx = 0; done = 0; tried = 0; seen = 0; syncSaid = 0; inWin = 0;
    noBind = skipNext; skipNext = 0;
    uint8_t ph = phase;
    if (ph == PH_OUT)       { phase = PH_BACK; startRec(1, d); push(EV_BACK_START, d); }
    else if (ph == PH_BACK) { phase = PH_EVAL; push(EV_CAL_END, 0); }
    else if (ph == PH_READY || ph == PH_KNIT) push(EV_TRAV, d);
  }

  CE_ISR void endTrav() {
    if (bound && !done) {                      // 区間を編み終える前に折り返した → 同じ段をもう一度
      armSlot = curSlot; warn |= W_PARTIAL; skipNext = 1; push(EV_PARTIAL, (int16_t)slot[curSlot].row);
    }
    bound = 0;
  }

  CE_ISR void startRec(int i, int8_t d) {
    PassRec& r = rec[i];
    r.dir = d; r.n = 0; r.ne = 0; r.nc = 0; r.ovf = 0; r.curOvf = 0;
  }

  CE_ISR void placeStep(int8_t d, uint8_t ipcH) {
    if (d == expectDir) {                      // 指示した向きに動き出した = 往路の始まり
      k = 0; ipcPrev = ipcH; segOpen = ipcH; wrongCnt = 0;
      // 前の空通しの復路の記録も消す (STATUS のカーソル検知に古い値を出さない)
      phase = PH_OUT; startRec(0, d); startRec(1, (int8_t)-d); rec[0].n = 1; push(EV_OUT_START, d);
    } else if (wrongCnt < 1000) {
      if (++wrongCnt == WRONG_DIR_N) { err = E_WRONG_DIR; push(EV_WRONG_DIR, d); }
    }
  }

  CE_ISR void addEdge(PassRec& r, int16_t cnt, uint8_t rise) {
    if (r.ne < MAX_EDGE) { r.e[r.ne].cnt = cnt; r.e[r.ne].rise = rise; r.ne++; } else r.ovf = 1;
  }

  CE_ISR void recStep(uint8_t ipcH, uint8_t cur) {
    PassRec& r = rec[phase == PH_OUT ? 0 : 1];
    r.n = k + 1;
    if (cur) { if (r.nc < MAX_CUR) r.cur[r.nc++] = k; else { r.ovf = 1; r.curOvf = 1; } }
    if (ipcH && !ipcPrev) {
      if (k < IN1_GUARD) segOpen = 1;           // 走り始めのパルス / カム区間の中から出発: ↑は記録しない
      else { segOpen = 0; riseAt = k; addEdge(r, k, 1); }
    } else if (!ipcH && ipcPrev) {
      if (segOpen) { segOpen = 0; if (k >= IN1_GUARD + MIN_SEG) addEdge(r, k, 0); }
      else if (k - riseAt < MIN_SEG) { if (r.ne) r.ne--; }   // 短い H は ↑ ごと取り消す
      else addEdge(r, k, 0);
    }
  }

  CE_ISR void syncErr() {
    warn |= W_SYNC;
    if (!syncSaid) { syncSaid = 1; push(EV_SYNC, j); }
  }

  // IPC の変化で位置を合わせる。テンプレート (同じ向きの空通し) のうち、
  // 位置が分かっていれば予測に一番近い同種の変化、分かっていなければ順番どおりの変化に合わせる。
  CE_ISR void anchorEdge(uint8_t rise) {
    const Tmpl& T = cal.t[dIdx(dir)];
    int idx = -1;
    if (anchored) {
      int best = SYNC_TOL + 1;
      for (int i = eIdx; i < T.ne; i++)
        if (T.e[i].rise == rise) { int dd = iabs(T.e[i].j - j); if (dd < best) { best = dd; idx = i; } }
      if (idx < 0) { syncErr(); return; }      // 予測と合わない: 位置は数え続ける
    } else {
      for (int i = eIdx; i < T.ne; i++) if (T.e[i].rise == rise) { idx = i; break; }
      if (idx < 0) return;
    }
    j = T.e[idx].j; anchored = 1; eIdx = (uint8_t)(idx + 1);
  }

  CE_ISR int winOf(int qq) const {
    for (int w = 0; w < cal.nwin; w++) if (qq >= cal.lo[w] && qq <= cal.hi[w]) return w;
    return -1;
  }

  CE_ISR uint8_t patBit(int qn) const {
    const RowSlot& s = slot[curSlot];
    int M = s.width * (s.h2 ? 2 : 1);
    if (M <= 0) return 0;
    int m = stitchRight ? qn : -qn;
    m %= M; if (m < 0) m += M;
    int st = s.h2 ? (m >> 1) : m;
    int b = bit0Right ? (s.width - 1 - st) : st;
    return (uint8_t)((s.bits[b >> 3] >> (b & 7)) & 1);
  }

  CE_ISR void bind() {
    if (armSlot >= 0) { curSlot = armSlot; armSlot = -1; bound = 1; seen = 0; push(EV_BIND, (int16_t)slot[curSlot].row); }
    else { warn |= W_NODATA; push(EV_NODATA, 0); }
  }

  CE_ISR void complete() {
    bound = 0; done = 1;
    RowSlot& s = slot[curSlot];
    if (seen != (uint8_t)((1 << cal.nwin) - 1)) {     // 区間の途中から編み始めた
      armSlot = curSlot; warn |= W_PARTIAL; push(EV_PARTIAL, (int16_t)s.row); return;
    }
    travDone++;
    warn &= (uint8_t)~(W_PARTIAL | W_NODATA);
    if (s.repeat > 1) { s.repeat--; armSlot = curSlot; push(EV_DONE_HALF, (int16_t)s.row); }
    else              { s.repeat = 0; push(EV_DONE, (int16_t)s.row); }
  }

  CE_ISR void knitStep(uint8_t ipcH, uint8_t cur) {
    ons = 0;
    if (!cal.ok) return;
    if (anchored) j++;
    if (cur) { if (anchored && iabs(j) > SYNC_TOL) syncErr(); j = 0; anchored = 1; }
    if (ipcH && !ipcPrev) {
      if (k < IN1_GUARD) segOpen = 1;
      else { segOpen = 0; riseAt = k; svA = anchored; svJ = j; svE = eIdx; anchorEdge(1); }
    } else if (!ipcH && ipcPrev) {
      if (segOpen) { segOpen = 0; if (k >= IN1_GUARD + MIN_SEG) anchorEdge(0); }
      else if (k - riseAt < MIN_SEG) {         // 短い H (ノイズ) は ↑ の位置合わせを取り消す
        anchored = svA; j = svA ? (int16_t)(svJ + (k - riseAt)) : 0; eIdx = svE;
      } else anchorEdge(0);
    }
    inWin = 0;
    if (!anchored) return;
    q = (int16_t)(dir * (j + cal.off));
    int w = winOf(q);
    if (w >= 0) {
      inWin = 1;
      uint8_t gate = (cal.pc3Ignored || !ipcGate || ipcH) ? 1 : 0;
      if (phase == PH_KNIT && !bound && !done && !tried && !noBind && gate) { tried = 1; bind(); }
      if (bound) { seen |= (uint8_t)(1 << w); if (gate) ons = patBit(q + dir * selAdj); }
    } else if (bound && (dir < 0 ? q < cal.farL : q > cal.farR)) {
      complete();
    }
  }

  // ---------------------------------------------------------------- loop 側 (呼ぶ側で割り込みを止める)
  bool pop(Ev& e) {
    if (evTail == evHead) return false;
    e = ev[evTail]; evTail = (uint8_t)((evTail + 1) & 15);
    return true;
  }

  void startCal(uint8_t side) {
    startSide = side ? 1 : 0;
    expectDir = startSide ? 1 : -1;            // 右端からなら往路は左へ
    lastDir = (int8_t)-expectDir;              // 開始側に置いた = そちらへ動いて止まったのと同じ
    phase = PH_PLACE; err = 0; warn = 0; cal.ok = 0; wrongCnt = 0;
    bound = 0; done = 1; armSlot = -1; ons = 0;
    startRec(0, expectDir); startRec(1, (int8_t)-expectDir);   // 前の空通しの記録 (カーソル検知) を消す
  }
  void idle() { wrongCnt = 0; }               // キャリッジが止まった

  // 復路の終わり (止まったまま一定時間) を loop が判定したとき
  bool endBackByIdle() {
    if (phase != PH_BACK || rec[1].n < 2) return false;
    phase = PH_EVAL; return true;
  }

  uint8_t fail(uint8_t e) { err = e; cal.ok = 0; phase = PH_PLACE; lastDir = (int8_t)-expectDir; return e; }

  // 往復の記録からポイントカム・カーソル・先行を求めて照合する。0 = 一致
  uint8_t evaluate() {
    const PassRec& a = rec[0];
    const PassRec& b = rec[1];
    uint8_t e = 0;
    if (a.ovf || b.ovf) e |= E_OVERFLOW;
    if (a.nc == 0 || b.nc == 0) e |= E_NO_CURSOR;
    else if (a.nc > 1 || b.nc > 1) e |= E_MULTI_CURSOR;
    int n = a.ne;
    if (a.ne == 0 && b.ne == 0) e |= E_NO_CAM;
    else if (a.ne != b.ne) e |= E_CAM_COUNT;
    else if (n > MAX_CAM) e |= E_TOO_MANY;
    else if (n < 2) e |= E_NO_CAM;             // PC2 がない = 選針区間がない
    if (e) return fail(e);
    int c1 = a.cur[0], c2 = b.cur[0];
    long sum = 0; int mn = 1 << 30, mx = -(1 << 30);
    for (int i = 0; i < n; i++) {
      int s2 = -(tval(a.e[i], c1) + tval(b.e[n - 1 - i], c2));   // = 2 × 先行
      sum += s2; if (s2 < mn) mn = s2; if (s2 > mx) mx = s2;
    }
    if (mx - mn > 2 * OFF_TOL) return fail(E_OFF);
    int off = roundDiv(sum, 2L * n);
    if (iabs(off) > OFF_MAX) return fail(E_OFF);
    Cal& c = cal;
    c.off = (int16_t)off; c.outDir = a.dir; c.ncam = (uint8_t)n;
    for (int i = 0; i < n; i++) c.cam[i] = (int16_t)(a.dir * (tval(a.e[i], c1) + off));
    c.nwin = (uint8_t)(n / 2); c.pc3Ignored = (n == 3);
    c.farL = 32767; c.farR = -32767;
    for (int w = 0; w < c.nwin; w++) {
      int p = c.cam[2 * w], r = c.cam[2 * w + 1];
      c.lo[w] = (int16_t)(p < r ? p : r); c.hi[w] = (int16_t)(p < r ? r : p);
      if (c.lo[w] < c.farL) c.farL = c.lo[w];
      if (c.hi[w] > c.farR) c.farR = c.hi[w];
    }
    Tmpl& ta = c.t[dIdx(a.dir)];
    Tmpl& tb = c.t[dIdx(b.dir)];
    ta.ne = a.ne; for (int i = 0; i < a.ne; i++) { ta.e[i].j = (int16_t)(a.e[i].cnt - c1); ta.e[i].rise = a.e[i].rise; }
    tb.ne = b.ne; for (int i = 0; i < b.ne; i++) { tb.e[i].j = (int16_t)(b.e[i].cnt - c2); tb.e[i].rise = b.e[i].rise; }
    c.ok = 1; err = 0; phase = PH_READY;
    return 0;
  }

  // 編み込みの開始 / 停止
  void startKnit() { if (cal.ok) { phase = PH_KNIT; travDone = 0; warn = 0; done = 1; } }
  void stopKnit()  {
    if (phase == PH_KNIT) phase = cal.ok ? PH_READY : PH_UNCAL;
    bound = 0; done = 1; armSlot = -1; ons = 0;
  }

  // 1 パス分のデータを次のトラバース用に置く (縦2倍は repeat = 2)
  void arm(const uint8_t* bits, int width, uint8_t h2, uint8_t repeat, uint16_t row, uint8_t ctrl, uint8_t pno, uint8_t cno) {
    int s = bound ? (curSlot ^ 1) : curSlot;
    RowSlot& r = slot[s];
    int nb = (width + 7) >> 3; if (nb > ROW_BYTES_CE) nb = ROW_BYTES_CE;
    for (int i = 0; i < ROW_BYTES_CE; i++) r.bits[i] = i < nb ? bits[i] : 0;
    r.width = (int16_t)width; r.h2 = h2; r.repeat = repeat ? repeat : 1;
    r.row = row; r.ctrl = ctrl; r.pno = pno; r.cno = cno;
    armSlot = (int8_t)s;
  }

  // 表示・STATUS 用
  int8_t nextDir() const { return lastDir ? (int8_t)-lastDir : expectDir; }
};

}  // namespace ce
// ==== CARRIAGE ENGINE END ====================================================

// ---- ユーザ設定 -------------------------------------------------------------
// WiFi の接続先は SD カードの /wifi.cnf (1行目 SSID / 2行目 パスワード) から読む。
static const char*    WIFI_CNF_PATH     = "/wifi.cnf";
static const char*    WIFI_SSID_DEFAULT = "SilverReed";  // wifi.cnf がないときの接続先
static const char*    WIFI_PASS_DEFAULT = "12345678";
static const char*    HOSTNAME_DEFAULT  = "knit-m5";     // INFO 応答 / mDNS 名 (ポータルで変更可)
static const uint16_t WS_PORT       = 21075;             // "SR" LE = Silver Reed
/* WebSocket の生存確認 (仕様書 7.4)。古いクライアントスロットの自動回収に必須。
   rev.42: ライブラリのハートビート (全クライアント共通) をやめ、自前で ping を送ってクライアントごとに待つ時間を変える。
   送信相手 (SRパタコン) は糸処理などでタブレットがスリープしても LINK_TIMEOUT_MS (10 分) まではつないだままにする。 */
static const uint32_t WS_PING_INTERVAL_MS = 15000;       // この間隔で全クライアントへ ping を送る
static const uint32_t PROBE_TIMEOUT_MS    = 36000;       // 送信相手以外 (探索のプローブ・閉じ残し) は応答がこの時間なければ切る
static const uint32_t LINK_TIMEOUT_MS     = 10UL * 60 * 1000;   // 送信相手は応答 (pong・フレーム) がこの時間なければ切る (rev.42)
static const uint8_t  WS_SLOTS            = 8;           // 見張るクライアント番号の数 (ライブラリの上限 5 より多め)
static const int      WIFI_TRIES              = 5;       // この回数試して繋がらなければ設定ポータル
static const uint32_t WIFI_TRY_TIMEOUT_MS     = 6000;    // 1 回の接続試行の待ち時間
static const uint32_t PORTAL_IDLE_RESTART_MS  = 5UL * 60 * 1000; // ポータル放置で再起動→再接続
static const uint32_t PORTAL_HOLD_MS          = 2000;    // 動作中に C ボタンをこの時間押すとポータル
static const uint32_t KICK_HOLD_MS            = 2000;    // A と C を同時にこの時間押すと SRパタコンとのリンクを切る (rev.37)
static const uint32_t KICK_WAIT_MS            = 1000;    // 切断要求 [85] を送ってから、SRパタコンが閉じるのを待つ時間
static const bool     BEEP_ON_COLOR_CHANGE = false; // 糸色が変わるパスで短く鳴らす (多色のみ)

// ---- キャリッジ制御 (仕様書 6.9) ---------------------------------------------
static const bool     CARRIAGE_ENABLE   = true;   // false = 表示専用 (キャリッジを使わず、受信したら即 ACK / proto v2)
static const bool     MBUS_5V_INPUT     = true;   // true = M-Bus の 5V から給電を受ける (本体から M-Bus へ 5V を出さない)
static const bool     ONS_ACTIVE_HIGH   = false;  // 選針出力の論理。false = L (GND) で選針・H (5V) で平編み (INS と同じ。rev.46)。true = H で選針
static const bool     STITCH_RIGHTWARD  = true;   // 目番号はカーソル (目1) から右へ増える。実機で左右が逆なら false
static const int      SEL_ADJ           = 0;      // 選針する針の補正 (目、進行方向へ +)。実機で柄が 1 目ずれるとき
static const bool     IPC_GATE          = true;   // IPC が H の間だけ選針する (PC3 を無視したときは位置だけで判定)
static const uint32_t CAL_END_IDLE_MS   = 1500;   // 空通しの復路のあと、止まってこの時間で判定する
static const uint32_t MOVE_IDLE_MS      = 400;    // INP がこの時間来なければ「止まっている」
static const uint8_t  VOL_LEVELS        = 10;     // 音声の音量の段階 (1..10)。接続待ちの画面で B / C で変える (rev.41)
static const uint8_t  VOL_DEFAULT       = 8;      // 保存した音量がないときの段階 (= 200。以前の VOICE_VOLUME と同じ)
static const uint8_t  VOL_UNIT          = 25;     // 1 段あたりの M5.Speaker の音量 (段階 × 25 = 25..250、0..255 のうち)
static const bool     VOICE_EACH_PASS   = false;  // 編み込み中、パスごとに「左へ」「右へ」と言う
static const char*    VOICE_DIR         = "/voice"; // 音声ファイルのフォルダ (SD カード)
static const uint8_t  VOICE_CH          = 0;      // 音声に使うスピーカーのチャンネル (ブザー音は別のチャンネル)

// 機種ごとのピン (M5BUS の同じ位置)。{ 選針 ONS, INP, ICD, IN1, IPC }
static const IoPins PINS_CORE2  = { 14, 13, 27, 36, 19 };
static const IoPins PINS_CORES3 = { 17, 18,  6,  8,  7 };   // CoreS3 / CoreS3 Lite / CoreS3 SE
static const int    BTNBAR_H    = 24;    // CoreS3: 画面の下のこの高さを A・B・C のタッチボタンにする

// ---- プロトコル定数 (クライアントと一致させること) --------------------------
// クライアント → サーバ
static const uint8_t C2S_MODE_ENTER = 0x01; // v1:[01][目数LE][段数LE][keyFlags]
                                            // v2:v1 +[パス数N][パレット 8色×RGB 24byte]
static const uint8_t C2S_ROW_DATA   = 0x02; // v1:[02][段番号LE][keyFlags][ctrl4][dir][目数LE][bits...]
                                            // v2:v1 +[パス番号 1..N][色番号 0..7]
static const uint8_t C2S_STOP       = 0x03; // [03]
static const uint8_t C2S_CALIB      = 0x04; // [04][開始側 0=右端/1=左端]  空通しを始める (v3)
static const uint8_t C2S_BYE        = 0x05; // [05]  SRパタコンの「切断」・閉じる。閉じる直前に送る (rev.36)
static const uint8_t C2S_HELLO      = 0x10; // [10]                探索プローブ
// サーバ → クライアント (型タグ bit7 = 1)
static const uint8_t S2C_READY      = 0x81; // [81][ver]
static const uint8_t S2C_ACK        = 0x82; // [82][段番号LE]
static const uint8_t S2C_STOPPED    = 0x83; // [83]
static const uint8_t S2C_STATUS     = 0x84; // [84][39byte]   キャリッジの状態 (v3、計 40 バイト、仕様書 6.3.6)
static const uint8_t S2C_BYE        = 0x85; // [85]  切断要求。本体の A+C 長押しで送る。SRパタコンは閉じてパターン表示に戻る (rev.37)
static const uint8_t S2C_NAK        = 0x8f; // [8f][段番号LE][code]
static const uint8_t S2C_INFO       = 0x90; // [90][clientIP4][hostname...]

static const uint8_t PROTO_VER = 3;         // 3 = キャリッジ制御 (CALIB / STATUS)。2 = 多色編み拡張
static const uint8_t PROTO_VER_DISPLAY = 2; // 表示専用 (キャリッジなし) で READY に返す版

// NAK コード
static const uint8_t NAK_ROW_BAD  = 1;      // ROW_DATA 破損 / 範囲外
static const uint8_t NAK_MODE_BAD = 2;      // MODE_ENTER 不正 (パス数が 2 や 9 以上 / 段数がパス数で割り切れない 等)
static const uint8_t NAK_PASS_BAD = 3;      // ROW_DATA のパス番号・色番号が段位置と食い違う
static const uint8_t NAK_UNCAL    = 4;      // 空通しが済んでいない (編み込みに入れない)
static const uint16_t NAK_NO_ROW  = 0xFFFF; // 段に属さない NAK (MODE_ENTER)

// keyFlags ビット (反転1/左右2/ミラー4/シェブロン8/縦2倍16/横2倍32) ← アプリ本体の割当と一致
static const uint8_t KF_INVERT  = 0x01; // 反転       … ビット列に反映済 (多色では使われない)
static const uint8_t KF_FLIP    = 0x02; // 左右反転   … ビット列に反映済
static const uint8_t KF_MIRROR  = 0x04; // ミラー     … ビット列に反映済
static const uint8_t KF_CHEVRON = 0x08; // シェブロン … ビット列に反映済
static const uint8_t KF_V2      = 0x10; // 縦2倍      … デバイス側でデザイン段を複製
static const uint8_t KF_H2      = 0x20; // 横2倍      … デバイス側で目複製 (表示で 2 倍描画)

// ---- 制約 -------------------------------------------------------------------
static const int MAX_STITCH = 240;
static const int MAX_ROW    = 1000;                  // デザイン段の上限 (送出段数は ×N まで)
static const int MAX_PASS   = 8;                     // n色編み = nパス
static const int MAX_COLORS = 8;                     // 色番号 0(地色)..7
static const int ROW_BYTES  = (MAX_STITCH + 7) / 8;  // 1 段の目ビット列の最大バイト数
static const size_t MODE_ENTER_V1_LEN = 6;
static const size_t MODE_ENTER_V2_LEN = 7 + MAX_COLORS * 3;  // = 31

// ---- ビット並び -------------------------------------------------------------
//   bit0 = 左端の目 (目1) / LSB→MSB / 行全体で連続 (ブロック分割しない) / 1 = 選針
//   仕様書 6.4: アプリの kcPackRow は左端 = bit0。U-BOX・PC10 とも同じ向き。
//   (旧版は true = 右端 で、アプリと左右が逆だった。実機で左右が逆に出るなら true にする)
static const bool STITCH_BIT0_AT_RIGHT = false;

static inline bool stitchMarked(const uint8_t* bits, int width, int visualLeftIdx) {
  // visualLeftIdx: 0 = 画面左端
  int d = STITCH_BIT0_AT_RIGHT ? (width - 1 - visualLeftIdx) : visualLeftIdx;
  return (bits[d >> 3] >> (d & 7)) & 1;
}

// ---- 多色編みのパス規約 (アプリの passColorNo / expandPassRows と一致) -------
static inline bool validPassCount(int n) { return n == 1 || (n >= 3 && n <= MAX_PASS); }
// パス pno(1起点) が担当する色番号。最終パスは地色(色0)。1パス(2色)はパス1=色1。
static inline int passColorNo(int pno, int n) { return (n >= 2 && pno == n) ? 0 : pno; }
// 送出段の添字からパス番号を求める。dir=0(段+) は段内のパスが逆順に積まれている。
static inline int passOfIdx(int idx, int n, uint8_t dir) {
  int k = idx % n;
  return dir == 0 ? n - k : k + 1;
}

// ---- 表示レイアウト ---------------------------------------------------------
static const int SCR_W  = 320;
static const int SCR_H  = 240;
static const int HDR_H  = 16;              // 1 行目: タイトル・IP・接続数・空通しの開始側
static const int GD_Y   = HDR_H;           // 案内 (日本語の表示) の上端
static const int PAT_Y  = 160;             // パターン領域の上端 (画面の下 1/3。rev.38)
static const int GD_H   = PAT_Y - 2 - GD_Y; // = 142 (下の 2px は区切り線)
static int       PAT_H  = SCR_H - PAT_Y;   // = 80 (CoreS3 は下の BTNBAR_H をタッチボタンにするので 56)
static int       g_btnBarH = 0;            // 画面の下のタッチボタンの高さ (CoreS3 だけ BTNBAR_H)
/* 1 マークの大きさ。既定は 2×2 px で、横に 160 マーク (=160目) まで入る。
   これを超えるパターンは全体が入らないので 1×1 px に落として 320 マークまで表示する
   (横2倍は目1つ = 2マーク、縦2倍は 2マーク高)。240目の横2倍 = 480マークだけは 1×1 でも
   入りきらないため、従来どおり右側を切って右端に印を付ける。 */
static const int MARK_PX_BIG = 2;
static const int MARK_PX_MIN = 1;
static inline int markCount(int width, uint8_t flags);   // 前方宣言 (KF_H2 は上で定義済み)
static inline int markPx(int width, uint8_t flags) {
  return markCount(width, flags) > SCR_W / MARK_PX_BIG ? MARK_PX_MIN : MARK_PX_BIG;
}
// 案内領域の右上: 現在パスの糸色パネル (案内領域の中の座標)
static const int SW_X = 214, SW_W = 104;   // 糸色見本 (パス番号を大きく出す。rev.38)
static const int SW_Y = 2,   SW_H = 70;
static const int CH_Y = 76,  CH_H = 18;    // パス順の色チップ

// 色 (RGB565 直値: TFT_* マクロ非依存)
static const uint16_t COL_BG     = 0x0000; // 黒
static const uint16_t COL_CLIP   = 0xFD20; // 橙 (幅が収まらず右側を切った段の右端の印)
static const uint16_t COL_TXT    = 0xFFFF; // 白
static const uint16_t COL_DARK   = 0x18E3; // #1D1D1D (明るい地の上の文字)
static const uint16_t COL_RUN    = 0x07E0; // 緑
static const uint16_t COL_STOP   = 0xFD20; // 橙
static const uint16_t COL_RDY    = 0x07FF; // シアン
static const uint16_t COL_LINE   = 0x7BEF; // グレー
static const uint16_t COL_CUR    = 0xFFE0; // 黄 (現在パスの枠)

// アプリの DEFAULT_PALETTE と同じ既定色 (v1 クライアント時に糸色パネルで使う)
static const uint8_t DEFAULT_PAL[MAX_COLORS][3] = {
  {0xFF,0xFF,0xFF}, {0x00,0x00,0x00}, {0xC0,0x39,0x2B}, {0x2E,0x5F,0xA3},
  {0xE8,0xC1,0x3F}, {0x3B,0x8B,0x5A}, {0x8B,0x5A,0x3B}, {0x9A,0xA3,0xAF},
};

static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
  return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}
/* 横に並ぶマーク数 (横2倍は目1つ = 2マーク) */
static inline int markCount(int width, uint8_t flags) { return width * ((flags & KF_H2) ? 2 : 1); }

/* 表示用の糸色。暗い糸色の持ち上げは多色 (3色以上) のときだけ行う。
   多色はデザイン段の途中で「まだ受け取っていない目」が背景の黒のまま残るため、
   黒に近い糸色 (アプリの既定では色1 = #000000) をそのまま塗ると見分けが付かない。
   輝度が MIN_LUMA 未満の色だけ最低限の明るさまで持ち上げる。色相は変えない (黒 → 濃いグレー)。
   2色 (1パス) は1段を受け取った時点で帯のすべての目が地色かマークで塗られ、受信前の目が
   残らないので持ち上げない。送られてきた色をそのまま出す (アプリの既定なら白地に真っ黒のマーク)。
   2色でも持ち上げたいときは LIFT_ALWAYS を true にする。 */
static const int MIN_LUMA = 56;
static const bool LIFT_ALWAYS = false;     // true = 2色でも暗い糸色を持ち上げる
static inline uint8_t liftCh(uint8_t v, int add) { int t = v + add; return (uint8_t)(t > 255 ? 255 : t); }
static inline int luma255(const uint8_t* c) { return (299 * c[0] + 587 * c[1] + 114 * c[2]) / 1000; }

// ---- 状態 -------------------------------------------------------------------
WebSocketsServer webSocket = WebSocketsServer(WS_PORT);
M5Canvas patCanvas(&M5.Display);           // パターン表示スプライト

enum SessionState { S_WAIT, S_READY, S_RUN, S_STOPPED };
SessionState g_state = S_WAIT;

int     g_width   = 0;   // 有効目数
int     g_rows    = 0;   // 送出段数 (= デザイン段数 × パス数)
uint8_t g_flags   = 0;
int     g_lastRow = -1;  // 最後に受けた段の添字 (ACK で返す値)
uint8_t g_lastCtrl= 0;
uint8_t g_lastDir = 0;
int     g_clients = 0;
bool    g_dirty   = true; // ステータス再描画フラグ

// ---- WiFi 設定 (NVS: ポータルで保存した接続先とホスト名) -------------------------
NetConfig   g_cfg;
Preferences g_prefs;
static const char* NVS_NS = "knitctrl";

static void loadConfig() {
  g_cfg.ssid[0] = 0; g_cfg.pass[0] = 0;
  strlcpy(g_cfg.host, HOSTNAME_DEFAULT, sizeof(g_cfg.host));
  if (g_prefs.begin(NVS_NS, true)) {                 // 読み取り専用。未作成なら false
    if (g_prefs.isKey("ssid")) g_prefs.getString("ssid", g_cfg.ssid, sizeof(g_cfg.ssid));
    if (g_prefs.isKey("pass")) g_prefs.getString("pass", g_cfg.pass, sizeof(g_cfg.pass));
    if (g_prefs.isKey("host")) g_prefs.getString("host", g_cfg.host, sizeof(g_cfg.host));
    g_prefs.end();
  }
  if (!g_cfg.host[0]) strlcpy(g_cfg.host, HOSTNAME_DEFAULT, sizeof(g_cfg.host));
}

static bool saveConfig(const NetConfig& c) {
  if (!g_prefs.begin(NVS_NS, false)) return false;
  bool ok = g_prefs.putString("ssid", c.ssid) == strlen(c.ssid)
         && g_prefs.putString("pass", c.pass) == strlen(c.pass)
         && g_prefs.putString("host", c.host) == strlen(c.host);
  g_prefs.end();
  return ok;
}

static void clearConfig() {
  if (g_prefs.begin(NVS_NS, false)) { g_prefs.clear(); g_prefs.end(); }
}

// ---- WiFi 設定 (SD: /wifi.cnf) --------------------------------------------------
SdWifi g_sd;
bool   g_sdMounted = false;   // SD をマウントしたまま (音声ファイルを読む)

static uint32_t fnv1a(uint32_t h, const char* s) {
  while (*s) { h ^= (uint8_t)*s++; h *= 16777619UL; }
  return h;
}

// 1行目 = SSID、2行目 = パスワード。行末 CR/LF と先頭 BOM を除き、それ以外は平文そのまま。
static void parseWifiCnf(const char* buf, size_t n, SdWifi& out) {
  char line[2][66] = {{0}, {0}};
  int ln = 0; size_t k = 0; bool tooLong = false;
  size_t i = (n >= 3 && (uint8_t)buf[0] == 0xEF && (uint8_t)buf[1] == 0xBB && (uint8_t)buf[2] == 0xBF) ? 3 : 0;
  for (; i <= n && ln < 2; i++) {
    char c = (i < n) ? buf[i] : '\n';
    if (c == '\r') continue;
    if (c == '\n') { line[ln][k] = 0; ln++; k = 0; continue; }
    if (k < 64) line[ln][k++] = c; else tooLong = true;
  }
  size_t ls = strlen(line[0]), lp = strlen(line[1]);
  if (tooLong || ls < 1 || ls > 32 || (lp > 0 && (lp < 8 || lp > 63))) { out.state = SDW_BAD; return; }
  strlcpy(out.ssid, line[0], sizeof(out.ssid));
  strlcpy(out.pass, line[1], sizeof(out.pass));
  out.sig   = fnv1a(fnv1a(fnv1a(2166136261UL, out.ssid), "\n"), out.pass);
  if (out.sig == 0) out.sig = 1;                     // 0 は「未記録」に使う
  out.state = SDW_OK;
}

static void readSdWifi() {
  memset(&g_sd, 0, sizeof(g_sd));
  g_sd.state = SDW_NO_CARD;
  int cs = M5.getPin(m5::pin_name_t::sd_spi_cs);
  if (cs < 0) cs = GPIO_NUM_4;
  if (M5.hasSD()) {
    SPI.begin(M5.getPin(m5::pin_name_t::sd_spi_sclk), M5.getPin(m5::pin_name_t::sd_spi_miso),
              M5.getPin(m5::pin_name_t::sd_spi_mosi), cs);
  }
  if (!SD.begin(cs, SPI, 25000000)) return;
  File f = SD.open(WIFI_CNF_PATH, FILE_READ);
  if (!f || f.isDirectory()) {
    g_sd.state = SDW_NO_FILE;
  } else {
    char buf[256];
    size_t n = f.read((uint8_t*)buf, sizeof(buf) - 1);
    buf[n] = 0;
    parseWifiCnf(buf, n, g_sd);
  }
  if (f) f.close();
  g_sdMounted = true;          // 音声ファイル (/voice) を読むので、マウントしたままにする
}

static const char* sdStateText() {
  switch (g_sd.state) {
    case SDW_NO_CARD: return "no SD card";
    case SDW_NO_FILE: return "no wifi.cnf";
    case SDW_OK:      return "wifi.cnf OK";
    default:          return "wifi.cnf invalid";
  }
}

// wifi.cnf が前回読んだ内容から変わっていたら、ポータルで保存した接続先を消す (SD を優先)
static void applySdChange() {
  if (g_sd.state != SDW_OK) return;
  if (!g_prefs.begin(NVS_NS, false)) return;
  uint32_t prev = g_prefs.getUInt("sdsig", 0);
  if (prev != g_sd.sig) {
    if (g_prefs.isKey("ssid")) { g_prefs.remove("ssid"); g_prefs.remove("pass"); }
    g_prefs.putUInt("sdsig", g_sd.sig);
    Serial.printf("[WiFi] wifi.cnf changed -> use SD (%s)\n", g_sd.ssid);
  }
  g_prefs.end();
}

// 接続候補: ① ポータルで保存した値 (NVS)  ② wifi.cnf (なければ既定 SilverReed)
WifiCand g_cands[2];
int      g_nCands = 0;

static void buildCandidates() {
  g_nCands = 0;
  if (g_cfg.ssid[0]) g_cands[g_nCands++] = { g_cfg.ssid, g_cfg.pass, "NVS" };
  bool sd = (g_sd.state == SDW_OK);
  WifiCand c = { sd ? g_sd.ssid : WIFI_SSID_DEFAULT, sd ? g_sd.pass : WIFI_PASS_DEFAULT, sd ? "SD" : "DEFAULT" };
  if (!(g_nCands && !strcmp(g_cands[0].ssid, c.ssid) && !strcmp(g_cands[0].pass, c.pass))) g_cands[g_nCands++] = c;
}

// 多色
int      g_passes    = 1;          // 1 デザイン段あたりのパス数 N
bool     g_hasPal    = false;      // アプリからパレットを受け取ったか (false = 内蔵の既定色)
uint8_t  g_palRGB[MAX_COLORS][3];  // 表示用の糸色 (暗すぎる色は liftCh で持ち上げたあとの値)
uint16_t g_pal565[MAX_COLORS];
int      g_lastPass  = 0;          // 0 = 未受信
int      g_lastColor = 0;
int      g_lastDesignNo = 0;       // 表示段番号 (段1 = 最下段)

// パターン表示: 最下段の帯 = 編成中のデザイン段の合成
static const uint8_t COMPO_EMPTY = 0xFF;   // どのパスでもまだ編んでいない目
int     g_bandDesign = -1;                 // 帯が表しているデザイン段 (内部添字)
uint8_t g_compo[MAX_STITCH];               // 目ごとの合成色番号

// パスバッファ: 編成中のデザイン段で受け取ったパス (LCD の合成図を組み立てる)
uint8_t g_passBits[MAX_PASS][ROW_BYTES];
bool    g_passHave[MAX_PASS];
int     g_bufDesign = -1;
int     g_bufWidth  = 0;

static void clearPassBuf() {
  for (int i = 0; i < MAX_PASS; i++) g_passHave[i] = false;
  g_bufDesign = -1; g_bufWidth = 0;
}

/* アプリ (MODE_ENTER [7..30]) から受け取った 8色 × RGB をそのまま表示色にする。
   rgb == nullptr のときだけ内蔵の既定色を使う (パレットを送らない v1 クライアント)。 */
static void setPalette(const uint8_t* rgb /* 8×3 or nullptr */) {
  /* 持ち上げるかどうかはパス数で決まる。g_passes は onModeEnter でこの呼び出しの前に確定している */
  const bool lift = (LIFT_ALWAYS || g_passes >= 2);
  for (int i = 0; i < MAX_COLORS; i++) {
    const uint8_t* c = rgb ? rgb + i * 3 : DEFAULT_PAL[i];
    int lum = luma255(c), add = (lift && lum < MIN_LUMA) ? MIN_LUMA - lum : 0;  // 黒い画面で埋もれる色だけ持ち上げる
    g_palRGB[i][0] = liftCh(c[0], add); g_palRGB[i][1] = liftCh(c[1], add); g_palRGB[i][2] = liftCh(c[2], add);
    g_pal565[i] = rgb565(g_palRGB[i][0], g_palRGB[i][1], g_palRGB[i][2]);
  }
  g_hasPal = (rgb != nullptr);
  Serial.printf("[PAL] %s c1=%02X%02X%02X c2=%02X%02X%02X ground=%02X%02X%02X\n", g_hasPal ? "from app" : "built-in",
                g_palRGB[1][0], g_palRGB[1][1], g_palRGB[1][2],
                g_palRGB[2][0], g_palRGB[2][1], g_palRGB[2][2],
                g_palRGB[0][0], g_palRGB[0][1], g_palRGB[0][2]);
}

// 背景色の上に置く文字色 (アプリの fgOn と同じ閾値)
static uint16_t textOn(int cno) {
  const uint8_t* c = g_palRGB[cno & 7];
  int lum1000 = (299 * c[0] + 587 * c[1] + 114 * c[2]) / 255;  // 0..1000
  return lum1000 > 550 ? COL_DARK : COL_TXT;
}

// ---- 1 パス (物理段) の編成 --------------------------------------------------
// bits: 左端 = bit0 / width 目。H2 なら目を 2 倍に展開して選針する。
// cno : このパスで使う糸の色番号 (0 = 地色)。replay = 縦2倍の 2 回目。
static void knitPass(const uint8_t* bits, int width, uint8_t ctrl,
                     int pno, int cno, uint8_t flags, bool replay) {
  (void)bits; (void)width; (void)flags;
  // 表示専用 (キャリッジなし) のときだけ通る。キャリッジ制御は ce::Engine が割り込みで選針し、
  // 編み終えたら ACK を返す (processEvents)。ctrl bit3 = ブザー / 下位3bit = 指示記号 (付録B)。
  Serial.printf("[KNIT] pass %d/%d color %d ctrl=0x%X%s\n",
                pno, g_passes, cno, ctrl, replay ? " (V2 replay)" : "");
}

// ---- パターン描画 -----------------------------------------------------------
void resetPattern() {
  patCanvas.fillSprite(COL_BG);
  patCanvas.pushSprite(0, PAT_Y);
  g_bandDesign = -1;
}

// 1 デザイン段の帯の高さ。縦2倍は 2 マーク高
static inline int bandPx(int width, uint8_t flags) { return markPx(width, flags) * ((flags & KF_V2) ? 2 : 1); }

/* 合成図の目の色。パス数によらず、アプリから受け取った糸色でそのまま塗る (編み上がりの見た目)。
   ・2色 (1パス): 選針目 = 色1、非選針目 = 地色 (色0)。アプリの既定では白地に黒マークになる。
     以前は青 (#2060FF) と黒の固定色で描いていたが、アプリで配色を変えても反映されないため取りやめた。
   ・多色 (3色以上): 色番号0 は地色であり、最終パスで選針された目とどのパスにも選ばれなかった目の
     両方がこれになる。
   パレットを受け取れていない v1 クライアントでは内蔵の既定色 (色0=白 / 色1=黒。アプリの
   DEFAULT_PALETTE と同じ) を使うので、この場合も白地に黒マークとなる。
   まだどのパスも受け取っていない目は COMPO_EMPTY のまま塗らない (背景の黒が残る)。 */
static uint16_t stitchColor(uint8_t cno) { return g_pal565[cno & 7]; }

// 最下段の帯を g_compo から描き直す。1 マーク 2×2 px (160マークを超えるパターンは 1×1 px)、
// 画面に収まれば中央寄せ、入りきらない分は右側を切って右端に橙の印を付ける。
// 同色の連続は 1 矩形にまとめる。
static void drawBand(int width, uint8_t flags) {
  bool h2    = flags & KF_H2;
  int  px    = markPx(width, flags);
  int  MARKS_W = SCR_W / px;                                 // 画面に入るマーク数 (2px=160 / 1px=320)
  int  bh    = bandPx(width, flags);
  int  marks = markCount(width, flags);                      // 横2倍: 目1つ = 2 マーク
  int  shown = marks < MARKS_W ? marks : MARKS_W;
  int  x0    = (SCR_W - shown * px) / 2;                     // 収まるときは中央寄せ
  int  y     = PAT_H - bh;
  patCanvas.fillRect(0, y, SCR_W, bh, COL_BG);
  int j = 0;
  while (j < shown) {
    uint8_t c = g_compo[h2 ? (j >> 1) : j];
    int e = j + 1;
    while (e < shown && g_compo[h2 ? (e >> 1) : e] == c) e++;
    if (c != COMPO_EMPTY) patCanvas.fillRect(x0 + j * px, y, (e - j) * px, bh, stitchColor(c));
    j = e;
  }
  if (marks > MARKS_W) patCanvas.fillRect(SCR_W - 1, y, 1, bh, COL_CLIP);
}

// 合成図の最下段の帯を、パスバッファ (このデザイン段で受け取ったパス) から組み立てて描く。
// デザイン段が変わったら (パス1で) 上へスクロールして新しい帯を始める。停止→再開で表示が
// クリアされても、同じデザイン段の受信済みパスはバッファに残っているので帯を復元できる。
static void drawDesignBand(int design, int width, int pno, uint8_t flags) {
  if (pno == 1 || design != g_bandDesign) {
    patCanvas.scroll(0, -bandPx(width, flags));             // 既存を上へ送る
    g_bandDesign = design;
  }
  int n = g_passes;
  for (int x = 0; x < MAX_STITCH; x++) g_compo[x] = COMPO_EMPTY;
  bool all = true;
  for (int i = 0; i < n; i++) {
    if (!g_passHave[i]) { all = false; continue; }
    int cno = passColorNo(i + 1, n);
    for (int x = 0; x < width; x++) {
      if (stitchMarked(g_passBits[i], width, x)) g_compo[x] = (uint8_t)cno;
      else if (n < 2)                            g_compo[x] = 0; // 2色(1パス): 非選針がそのまま地色
    }
  }
  if (n >= 2 && all)                                        // 全パスが揃えば、どのパスにも選ばれなかった目は地色
    for (int x = 0; x < width; x++) if (g_compo[x] == COMPO_EMPTY) g_compo[x] = 0;
  drawBand(width, flags);
  patCanvas.pushSprite(0, PAT_Y);
}

// ---- 音声ガイド (仕様書 6.9.6) ------------------------------------------------
/* SD カードの /voice/NN.wav を鳴らす。NN = 下の番号 (2 桁)。中身はこの表の文を読み上げたもの
   (添付の KnitCtrl_voice.zip は VOICEVOX の青山龍星。クレジット「VOICEVOX:青山龍星」。rev.40)。
   ファイルがない・SD がない・メモリが足りないときは、案内の種類に応じたブザー音で代える。 */
enum : uint8_t {
  V_NONE = 0, V_PLACE_R, V_PLACE_L, V_BACK_R, V_BACK_L, V_CAL_OK, V_CAL_NG, V_WRONG_DIR,
  V_NO_CURSOR, V_NO_CAM, V_START_L, V_START_R, V_STOPPED, V_NODATA, V_PARTIAL, V_SYNC,
  V_NEED_CAL, V_LEFT, V_RIGHT, V_CONNECT, V_PC3, V_MULTI_CURSOR, V_BOOT, V_WAIT_APP, V_LINK_LOST, V_COUNT
};
static const char* const VOICE_TEXT[V_COUNT] = {
  "",
  "キャリッジを右端に置いて、左へ空通ししてください。",          // 01
  "キャリッジを左端に置いて、右へ空通ししてください。",          // 02
  "右へ戻して、空通ししてください。",                            // 03
  "左へ戻して、空通ししてください。",                            // 04
  "空通しが完了しました。SRパタコンで、パターン送信を開始してください。", // 05
  "ポイントカムとカーソルの位置が一致しません。もう一度、空通ししてください。", // 06
  "キャリッジの向きが違います。",                                // 07
  "カーソルが見つかりません。",                                  // 08
  "ポイントカムが見つかりません。",                              // 09
  "編み込みを開始します。キャリッジを左へ動かしてください。",    // 10
  "編み込みを開始します。キャリッジを右へ動かしてください。",    // 11
  "パターン送信が停止しました。",                                // 12
  "パターンデータが届いていません。この段は平編みになります。",  // 13
  "段の途中で折り返しました。同じ段をもう一度編みます。",        // 14
  "針の位置がずれています。空通しをやり直してください。",        // 15
  "先に空通しをしてください。",                                  // 16
  "左へ",                                                        // 17
  "右へ",                                                        // 18
  "SRパタコンと接続しました。",                                  // 19
  "ポイントカム3は使いません。",                                 // 20
  "カーソルが2つ以上あります。",                                 // 21
  "編み機コントローラーを起動しました。",                        // 22
  "SRパタコンとの接続を解除しました。SRパタコンの接続を待っています。", // 23 切断・A+C で接続待ちになった (rev.42)
  "SRパタコンとの接続が切れました。SRパタコンから接続し直してください。", // 24 応答が 10 分途絶えた (rev.42)
};

struct VoicePlayer {
  uint8_t  q[6] = {0};
  uint8_t  n = 0;
  uint8_t* buf = nullptr;
  void say(uint8_t id) { if (id && id < V_COUNT && n < sizeof(q)) q[n++] = id; }
  void clear() { n = 0; }
};
VoicePlayer g_voice;

// 案内の種類ごとのブザー音 (音声ファイルがないとき)
static void voiceBeep(uint8_t id) {
  switch (id) {
    case V_CAL_NG: case V_WRONG_DIR: case V_NO_CURSOR: case V_NO_CAM: case V_NODATA:
    case V_PARTIAL: case V_SYNC: case V_NEED_CAL: case V_MULTI_CURSOR: case V_LINK_LOST:
      M5.Speaker.tone(880, 120, 1); delay(160); M5.Speaker.tone(880, 120, 1); break;   // 注意: 低い音 2 回
    case V_CAL_OK: case V_START_L: case V_START_R: case V_CONNECT: case V_BOOT:
      M5.Speaker.tone(1760, 80, 1); delay(110); M5.Speaker.tone(2349, 160, 1); break;  // 完了・開始: 上がる 2 音
    default:
      M5.Speaker.tone(1760, 100, 1); break;
  }
}

static bool voicePlayFile(uint8_t id) {
  if (!g_sdMounted) return false;
  char path[24];
  snprintf(path, sizeof(path), "%s/%02u.wav", VOICE_DIR, (unsigned)id);
  File f = SD.open(path, FILE_READ);
  if (!f) return false;
  size_t len = f.size();
  uint8_t* b = nullptr;
  if (len > 44 && len < 600000) b = (uint8_t*)(psramFound() ? ps_malloc(len) : malloc(len));
  if (!b) { f.close(); return false; }
  size_t got = f.read(b, len);
  f.close();
  if (got != len) { free(b); return false; }
  g_voice.buf = b;
  return M5.Speaker.playWav(b, len, 1, VOICE_CH, true);
}

// loop から呼ぶ。再生が終わったらバッファを放し、次の案内を鳴らす
static void voiceUpdate() {
  if (M5.Speaker.isPlaying(VOICE_CH)) return;
  if (g_voice.buf) { free(g_voice.buf); g_voice.buf = nullptr; }
  if (!g_voice.n) return;
  uint8_t id = g_voice.q[0];
  memmove(g_voice.q, g_voice.q + 1, --g_voice.n);
  Serial.printf("[VOICE] %02u %s\n", (unsigned)id, VOICE_TEXT[id]);
  if (!voicePlayFile(id)) voiceBeep(id);
}

// ---- キャリッジ入出力 (仕様書 6.9.1) -------------------------------------------
ce::Engine   g_eng;
portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
IoPins       g_io = { -1, -1, -1, -1, -1 };
bool         g_carriage = false;        // キャリッジ制御が有効 (対応機種かつ CARRIAGE_ENABLE)
volatile uint8_t g_in1Flag = 0;         // IN1 の立ち下がりを見た (次の INP で使う)
volatile uint8_t g_in1Lvl  = 1;         // 前回の INP の時点の IN1 のレベル

static inline uint8_t IRAM_ATTR pinLevel(int pin) {
  return (uint8_t)(pin < 32 ? ((REG_READ(GPIO_IN_REG) >> pin) & 1) : ((REG_READ(GPIO_IN1_REG) >> (pin - 32)) & 1));
}
static inline void IRAM_ATTR pinWrite(int pin, uint8_t v) {
  if (pin < 32) REG_WRITE(v ? GPIO_OUT_W1TS_REG : GPIO_OUT_W1TC_REG, 1UL << pin);
  else          REG_WRITE(v ? GPIO_OUT1_W1TS_REG : GPIO_OUT1_W1TC_REG, 1UL << (pin - 32));
}
/* IN1 の立ち下がり。G36 のグリッチを捨てるため、読み直して L のときだけ印を付ける。
   直前の INP の時点ですでに L だったパルス (isrInp がレベルで数えた) には印を付けない (rev.34)。
   ESP32 の GPIO 割り込みは、端が同じ回にまとまると GPIO0-31 を番号順に呼んでから GPIO32-39 を呼ぶ。
   Core2 は INP = G13・IN1 = G36 なので、IN1 が INP↑ の数 µs 前に下がると isrInp が先に L を見て数え、
   そのあとこの割り込みが印を立てて、次の INP で同じパルスをもう一度数えていた (空通しが
   「カーソルが2つ以上」になる。カーソル 1 つが 0 と +1 の 2 つに見える)。CoreS3 は IN1 = G8 が先。 */
static void IRAM_ATTR isrIn1() { if (!pinLevel(g_io.in1) && g_in1Lvl) g_in1Flag = 1; }
// INP の立ち上がり = 1 目進んだ。ICD・IPC・IN1 を読んでエンジンを 1 目進め、選針を出す
static void IRAM_ATTR isrInp() {
  uint8_t icd = pinLevel(g_io.icd), ipc = pinLevel(g_io.ipc), nd = pinLevel(g_io.in1);
  portENTER_CRITICAL_ISR(&g_mux);
  uint8_t in1 = (g_in1Flag || (!nd && g_in1Lvl)) ? 1 : 0;   // 割り込みを取りこぼしても INP の時点の L で拾う
  g_in1Flag = 0; g_in1Lvl = nd;
  g_eng.step(icd, ipc, in1);
  uint8_t out = g_eng.ons;
  portEXIT_CRITICAL_ISR(&g_mux);
  pinWrite(g_io.ons, ONS_ACTIVE_HIGH ? out : (uint8_t)!out);
}

static void onsOff() { if (g_io.ons >= 0) pinWrite(g_io.ons, ONS_ACTIVE_HIGH ? 0 : 1); }

static bool setupCarriageIo() {
  if (!CARRIAGE_ENABLE) return false;
  auto b = M5.getBoard();
  if (b == m5::board_t::board_M5StackCore2) g_io = PINS_CORE2;
  else if (b == m5::board_t::board_M5StackCoreS3 || b == m5::board_t::board_M5StackCoreS3SE) g_io = PINS_CORES3;
  else return false;
  onsOff();                     // 出力にする前に平編みのレベルを出力レジスタに入れておく (L = 選針なので、
  pinMode(g_io.ons, OUTPUT);    //  出力にした瞬間に L を出さない。rev.46)
  onsOff();
  pinMode(g_io.inp, INPUT_PULLUP);
  pinMode(g_io.icd, INPUT_PULLUP);
  pinMode(g_io.ipc, INPUT_PULLUP);
  // Core2 (ESP32) の G34..39 は入力専用でプルアップなし。CoreS3 (ESP32-S3) はプルアップできる
  pinMode(g_io.in1, (b == m5::board_t::board_M5StackCore2 && g_io.in1 >= 34) ? INPUT : INPUT_PULLUP);
  g_eng.bit0Right   = STITCH_BIT0_AT_RIGHT ? 1 : 0;
  g_eng.stitchRight = STITCH_RIGHTWARD ? 1 : 0;
  g_eng.selAdj      = (int8_t)SEL_ADJ;
  g_eng.ipcGate     = IPC_GATE ? 1 : 0;
  g_in1Lvl = pinLevel(g_io.in1);
  attachInterrupt(digitalPinToInterrupt(g_io.inp), isrInp, RISING);
  attachInterrupt(digitalPinToInterrupt(g_io.in1), isrIn1, FALLING);
  Serial.printf("[IO] ONS=G%d INP=G%d ICD=G%d IN1=G%d IPC=G%d\n", g_io.ons, g_io.inp, g_io.icd, g_io.in1, g_io.ipc);
  return true;
}

// ---- 空通しの開始側 (NVS) ------------------------------------------------------
static uint8_t loadSide() {
  uint8_t s = 0;
  if (g_prefs.begin(NVS_NS, true)) { s = g_prefs.getUChar("cside", 0); g_prefs.end(); }
  return s ? 1 : 0;
}
static void saveSide(uint8_t s) {
  if (g_prefs.begin(NVS_NS, false)) { if (g_prefs.getUChar("cside", 0xFF) != s) g_prefs.putUChar("cside", s); g_prefs.end(); }
}

// ---- 音声の音量 (NVS。rev.41) ----------------------------------------------------
uint8_t g_volLv = VOL_DEFAULT;          // 音量の段階 1..VOL_LEVELS
static uint8_t loadVol() {
  uint8_t v = VOL_DEFAULT;
  if (g_prefs.begin(NVS_NS, true)) { v = g_prefs.getUChar("vol", VOL_DEFAULT); g_prefs.end(); }
  return (v >= 1 && v <= VOL_LEVELS) ? v : VOL_DEFAULT;
}
static void saveVol(uint8_t v) {
  if (g_prefs.begin(NVS_NS, false)) { if (g_prefs.getUChar("vol", 0xFF) != v) g_prefs.putUChar("vol", v); g_prefs.end(); }
}
static void applyVol() { M5.Speaker.setVolume((uint8_t)(g_volLv * VOL_UNIT)); }
// 音量を 1 段変える (d = −1 / +1)。変えたら保存して、その音量で短く鳴らす。端で変えられないときは低い音
static void stepVol(int d) {
  int v = (int)g_volLv + d;
  if (v < 1 || v > VOL_LEVELS) { M5.Speaker.tone(500, 60, 1); return; }
  g_volLv = (uint8_t)v;
  applyVol();
  saveVol(g_volLv);
  M5.Speaker.tone(1200, 80, 1);
  g_dirty = true;
  Serial.printf("[VOL] %u/%u (speaker %u)\n", g_volLv, VOL_LEVELS, g_volLv * VOL_UNIT);
}

// ---- 編み込みの状態 ----------------------------------------------------------
bool     g_sending    = false;   // SRパタコンがパターンを送っている (スタート〜ストップ)
int      g_mainClient = -1;      // MODE_ENTER / CALIB / ROW_DATA を送ってきたクライアント (STATUS / ACK の宛先)
bool     g_appLost    = false;   // 送信相手 (SRパタコン) との接続を切った (BYE・A+C)。つなぎ直すか本体のボタンで空通しを始めるまで (rev.35)
int      g_byeClient  = -1;      // BYE (SRパタコンの「切断」) を送ってきたクライアント。続く切断は意図したもの (rev.36)
bool     g_linkDrop   = false;   // BYE なしで切れた (ネットワーク等)。画面は変えず、つなぎ直すまで (rev.37)
bool     g_lostWait   = false;   // BYE なしで切れて、つなぎ直すのを待っている。LINK_TIMEOUT_MS たったら警告 (音声 24。rev.42)
uint32_t g_lostMs     = 0;       // その切れた時刻
bool     g_kick       = false;   // A+C で切断要求を送った (KICK_WAIT_MS 後に残りを切る)
uint32_t g_kickMs     = 0;       // その時刻
uint8_t  g_side       = 0;       // 空通しの開始側 0 = 右端 / 1 = 左端
bool     g_moving     = false;   // キャリッジが動いている
uint32_t g_lastTot    = 0, g_lastMoveMs = 0;
uint32_t g_needCalSaidMs = 0;
static const size_t STATUS_LEN = 40;   // [24..25] キャリッジの針位置 / [26] bit0 = 位置が分かっている (rev.32)
                                       // [27] [28..39] 空通しで検知したカーソル (rev.34)
uint8_t  g_lastStatus[STATUS_LEN];
uint32_t g_lastStatusMs = 0;
M5Canvas gdCanvas(&M5.Display);  // 案内の領域

static Snap snap() {
  Snap s;
  portENTER_CRITICAL(&g_mux);
  s.ph = g_eng.phase == ce::PH_EVAL ? (uint8_t)ce::PH_BACK : g_eng.phase;
  s.err = g_eng.err; s.warn = g_eng.warn; s.ok = g_eng.cal.ok;
  s.nwin = g_eng.cal.ok ? g_eng.cal.nwin : 0; s.pc3 = g_eng.cal.ok ? g_eng.cal.pc3Ignored : 0;
  s.ncam = g_eng.cal.ok ? g_eng.cal.ncam : 0;
  s.dir = g_eng.dir; s.lastDir = g_eng.lastDir; s.expDir = g_eng.expectDir; s.outDir = g_eng.cal.outDir;
  s.k = g_eng.k; s.off = g_eng.cal.ok ? g_eng.cal.off : 0;
  for (int i = 0; i < 2; i++) { s.lo[i] = g_eng.cal.lo[i]; s.hi[i] = g_eng.cal.hi[i]; }
  for (int i = 0; i < 4; i++) s.cam[i] = g_eng.cal.cam[i];
  s.trav = g_eng.travDone;
  const ce::PassRec& r = g_eng.rec[g_eng.phase == ce::PH_OUT ? 0 : 1];
  s.recN = r.n; s.recE = r.ne; s.recC = r.nc;
  s.q = g_eng.q;
  s.qOk = (g_eng.cal.ok && g_eng.anchored && (g_eng.phase == ce::PH_READY || g_eng.phase == ce::PH_KNIT)) ? 1 : 0;
  for (int p = 0; p < 2; p++) {                    // 空通しで検知したカーソル ([0] 往路 / [1] 復路)
    const ce::PassRec& c = g_eng.rec[p];
    uint8_t n = c.nc > ce::MAX_CUR ? (uint8_t)ce::MAX_CUR : c.nc;
    s.curN[p] = n; s.curOvf[p] = c.curOvf;
    for (int i = 0; i < 3; i++) s.curRel[p][i] = (i + 1 < n) ? (int16_t)(c.cur[i + 1] - c.cur[0]) : 0;
  }
  portEXIT_CRITICAL(&g_mux);
  return s;
}
// 次に動かす向き (−1 左へ / +1 右へ / 0 なし)
static int8_t nextMove(const Snap& s) {
  switch (s.ph) {
    case ce::PH_PLACE: return s.expDir;
    case ce::PH_OUT:   return s.expDir;
    case ce::PH_BACK:  return (int8_t)-s.expDir;
    case ce::PH_READY: case ce::PH_KNIT:
      return g_moving && s.dir ? s.dir : (s.lastDir ? (int8_t)-s.lastDir : s.expDir);
    default: return 0;
  }
}

/* 「SRパタコン接続待ち」の画面か (キャリッジ制御のとき)。アプリ (編み機コントロール) がつないでいない、起動直後か
   BYE・A+C で切ったあとの待機中 (未較正・空通し完了、空通し待ちで切れたとき)。BYE なしで切れたときは含めない (rev.37)。
   この画面では B / C で音声の音量を変える (rev.41) */
static bool appWaiting() {
  uint8_t ph = g_eng.phase;
  return g_carriage && g_mainClient < 0 && !g_linkDrop &&
         (ph == ce::PH_UNCAL || ph == ce::PH_READY || (ph == ce::PH_PLACE && g_appLost));
}

// ---- STATUS フレーム (仕様書 6.3.6) ---------------------------------------------
static void putI16(uint8_t* o, int v) { o[0] = (uint8_t)(v & 0xff); o[1] = (uint8_t)((v >> 8) & 0xff); }
static void buildStatus(uint8_t* o) {
  Snap s = snap();
  int8_t nx = nextMove(s);
  o[0]  = S2C_STATUS;
  o[1]  = s.ph;
  o[2]  = s.lastDir < 0 ? 1 : (s.lastDir > 0 ? 0 : 2);                 // キャリッジの位置 0 右端 / 1 左端 / 2 不明
  o[3]  = g_moving ? (s.dir < 0 ? 1 : 2) : 0;                          // 今の動き 0 停止 / 1 左へ / 2 右へ
  o[4]  = nx < 0 ? 1 : (nx > 0 ? 2 : 0);                               // 次に動かす向き
  o[5]  = g_side;                                                      // 空通しの開始側
  o[6]  = s.err;
  o[7]  = s.warn;
  putI16(o + 8, s.k);
  o[10] = s.nwin;
  o[11] = (uint8_t)((s.pc3 ? 1 : 0) | (s.ok ? 2 : 0));
  putI16(o + 12, s.off);
  putI16(o + 14, s.nwin > 0 ? s.lo[0] : 0); putI16(o + 16, s.nwin > 0 ? s.hi[0] : 0);
  putI16(o + 18, s.nwin > 1 ? s.lo[1] : 0); putI16(o + 20, s.nwin > 1 ? s.hi[1] : 0);
  putI16(o + 22, s.trav);
  putI16(o + 24, s.qOk ? s.q : 0);                                     // キャリッジの針位置 (カーソル基準、右が +)
  o[26] = s.qOk;                                                       // bit0 = 位置が分かっている
  /* [27] 空通しで検知したカーソルの数: bit0-2 往路 / bit3-5 復路 (各 4 まで)、bit6 / bit7 = 往路 / 復路で 5 つ以上
     [28..33] 往路の 2〜4 つめ / [34..39] 復路の 2〜4 つめのカーソル。その向きで最初に検知したカーソルを 0 として、
     進行方向へ何目あとか (INP の数)。スタート・反転のパルスは含まない (rev.34) */
  o[27] = (uint8_t)((s.curN[0] & 7) | ((s.curN[1] & 7) << 3) | (s.curOvf[0] ? 0x40 : 0) | (s.curOvf[1] ? 0x80 : 0));
  for (int p = 0; p < 2; p++)
    for (int i = 0; i < 3; i++) putI16(o + 28 + p * 6 + i * 2, s.curRel[p][i]);
}
// 変わったときだけ送る。針カウントとキャリッジの針位置だけの変化は 0.25 秒に 1 回まで
static void sendStatus(bool force) {
  if (!g_carriage || g_mainClient < 0) return;
  uint8_t o[STATUS_LEN];
  buildStatus(o);
  bool same = memcmp(o, g_lastStatus, sizeof(o)) == 0;
  if (!force && same) return;
  bool onlyCount = !same && memcmp(o, g_lastStatus, 8) == 0 && memcmp(o + 10, g_lastStatus + 10, 14) == 0
                   && memcmp(o + 26, g_lastStatus + 26, STATUS_LEN - 26) == 0;   // カーソル検知の変化はすぐ送る
  if (!force && onlyCount && millis() - g_lastStatusMs < 250) return;
  memcpy(g_lastStatus, o, sizeof(o));
  g_lastStatusMs = millis();
  webSocket.sendBIN((uint8_t)g_mainClient, o, sizeof(o));
}

// ---- 画面: ヘッダ + 案内 -------------------------------------------------------
static const char* ctrlSym(uint8_t c) {   // 付録B (＊ は ASCII の * で代用)
  switch (c & 7) { case 4: return "<"; case 2: return "*"; case 6: return "{";
                   case 1: return ">"; case 3: return "}"; default: return " "; }
}

// 空通しの不一致の理由 (表示用)
static const char* calErrText(uint8_t e) {
  if (e & ce::E_WRONG_DIR)    return "キャリッジの向きが違います";
  if (e & ce::E_NO_CURSOR)    return "カーソルが見つかりません";
  if (e & ce::E_MULTI_CURSOR) return "カーソルが2つ以上あります";
  if (e & ce::E_NO_CAM)       return "ポイントカム1・2がありません";
  if (e & ce::E_CAM_COUNT)    return "往復でポイントカムの数が違います";
  if (e & ce::E_TOO_MANY)     return "ポイントカムが多すぎます";
  if (e & ce::E_OFF)          return "往復で位置が一致しません";
  if (e & ce::E_OVERFLOW)     return "信号が多すぎます";
  return "";
}

// 案内領域の文字 (日本語: efont 16px、size 2 で 32px)
static void gdJ(int x, int y, uint16_t col, uint8_t size, const char* s) {
  gdCanvas.setFont(&fonts::efontJA_16); gdCanvas.setTextSize(size);
  gdCanvas.setTextColor(col); gdCanvas.setCursor(x, y); gdCanvas.print(s);
}
static void gdA(int x, int y, uint16_t col) {   // 以降 printf で ASCII 小文字 (6x8)
  gdCanvas.setFont(&fonts::Font0); gdCanvas.setTextSize(1);
  gdCanvas.setTextColor(col); gdCanvas.setCursor(x, y);
}
// 太い矢印。dir < 0 = ←、dir > 0 = →
static void gdArrow(int x, int y, int w, int h, int8_t dir, uint16_t col) {
  if (!dir) return;
  int head = h * 3 / 4, bar = h / 3;
  if (dir < 0) {
    gdCanvas.fillTriangle(x, y + h / 2, x + head, y, x + head, y + h - 1, col);
    gdCanvas.fillRect(x + head, y + (h - bar) / 2, w - head, bar, col);
  } else {
    gdCanvas.fillTriangle(x + w - 1, y + h / 2, x + w - 1 - head, y, x + w - 1 - head, y + h - 1, col);
    gdCanvas.fillRect(x, y + (h - bar) / 2, w - head, bar, col);
  }
}

// 文字の幅 (efontJA_16、倍率 size)
static int gdW(uint8_t size, const char* t) {
  gdCanvas.setFont(&fonts::efontJA_16); gdCanvas.setTextSize(size);
  return gdCanvas.textWidth(t);
}

// 右上: 現在パスの糸色見本 (「パス 色n」と パス番号を 3 倍で) + パス順の色チップ (案内領域の座標。rev.38)
static void drawPassPanel() {
  int n = g_passes;
  bool have = g_lastPass > 0;
  uint16_t bg = have ? g_pal565[g_lastColor & 7] : COL_BG, fg = have ? textOn(g_lastColor) : COL_TXT;
  gdCanvas.fillRect(SW_X, SW_Y, SW_W, SW_H, bg);
  gdCanvas.drawRect(SW_X, SW_Y, SW_W, SW_H, COL_LINE);
  char b[24];
  if (!have)                 snprintf(b, sizeof(b), "パス");
  else if (g_lastColor == 0) snprintf(b, sizeof(b), "パス  地色");
  else                       snprintf(b, sizeof(b), "パス  色%d", g_lastColor);
  gdJ(SW_X + 6, SW_Y + 3, fg, 1, b);
  if (have) snprintf(b, sizeof(b), "%d/%d", g_lastPass, n < 1 ? 1 : n);
  else      snprintf(b, sizeof(b), "-/%d", n < 1 ? 1 : n);
  uint8_t sz = gdW(3, b) <= SW_W - 8 ? 3 : 2;
  gdJ(SW_X + (SW_W - gdW(sz, b)) / 2, SW_Y + (sz == 3 ? 20 : 30), fg, sz, b);
  // チップはパスの順 (1パスは 色1 / 地色(非選針) の 2 つ)
  int cnt = (n < 2) ? 2 : n;
  for (int i = 0; i < cnt; i++) {
    int cno = (n < 2) ? (i == 0 ? 1 : 0) : passColorNo(i + 1, n);
    int x0 = SW_X + i * SW_W / cnt, x1 = SW_X + (i + 1) * SW_W / cnt;
    gdCanvas.fillRect(x0, CH_Y, x1 - x0, CH_H, g_pal565[cno]);
    bool cur = (g_lastPass > 0) && ((n < 2) ? (i == 0) : (g_lastPass == i + 1));
    gdCanvas.drawRect(x0, CH_Y, x1 - x0, CH_H, cur ? COL_CUR : COL_LINE);
    if (cur && x1 - x0 > 4) gdCanvas.drawRect(x0 + 1, CH_Y + 1, x1 - x0 - 2, CH_H - 2, COL_CUR);
  }
}

// 段を大きく: 「段」+ 今のデザイン段 (3 倍、黄) + 「/全段」。y = 3 倍の文字の上端。入らなければ 2 倍 (rev.38)
static void drawRowBig(int y) {
  int designRows = g_passes > 0 ? g_rows / g_passes : 0;
  char cur[12], tot[12];
  if (g_lastPass > 0) snprintf(cur, sizeof(cur), "%d", g_lastDesignNo); else snprintf(cur, sizeof(cur), "-");
  snprintf(tot, sizeof(tot), "/%d", designRows);
  int room = SW_X - 6 - 42;                                   // 「段」の右から糸色見本まで
  uint8_t sz = (gdW(3, cur) + 4 + gdW(2, tot) <= room) ? 3 : 2;
  gdJ(6, y + 16, COL_TXT, 2, "段");
  gdJ(42, sz == 3 ? y : y + 16, COL_CUR, sz, cur);
  gdJ(42 + gdW(sz, cur) + 4, y + 16, COL_TXT, 2, tot);
}

// 制御ニブル・keyFlags・送出段の 1 行 (ASCII)
static void drawCtrlLine(int y) {
  gdA(6, y, COL_LINE);
  if (g_lastRow >= 0) gdCanvas.printf("IDX %d/%d %s ", g_lastRow, g_rows, g_lastDir ? "UP" : "DOWN");
  gdCanvas.printf("CTRL:%d%d%d%d %s%s ", (g_lastCtrl >> 3) & 1, (g_lastCtrl >> 2) & 1, (g_lastCtrl >> 1) & 1, g_lastCtrl & 1,
                  ctrlSym(g_lastCtrl), (g_lastCtrl & 8) ? " BZ" : "");
  gdCanvas.printf("%s%s%s%s%s%s", (g_flags & KF_INVERT) ? "INV " : "", (g_flags & KF_FLIP) ? "FLP " : "",
                  (g_flags & KF_MIRROR) ? "MIR " : "", (g_flags & KF_CHEVRON) ? "CHV " : "",
                  (g_flags & KF_V2) ? "V2 " : "", (g_flags & KF_H2) ? "H2" : "");
}

// 表示専用 (キャリッジなし) の案内領域: 従来の状態表示
static void drawLegacyBody() {
  const char* st = "WAIT"; uint16_t stc = COL_TXT;
  switch (g_state) {
    case S_WAIT:    st = "WAIT";  stc = COL_TXT;  break;
    case S_READY:   st = "READY"; stc = COL_RDY;  break;
    case S_RUN:     st = "RUN";   stc = COL_RUN;  break;
    case S_STOPPED: st = "STOP";  stc = COL_STOP; break;
  }
  gdCanvas.setFont(&fonts::Font0);
  gdCanvas.setTextSize(2); gdCanvas.setTextColor(stc); gdCanvas.setCursor(6, 6); gdCanvas.printf("%-5s", st);
  gdA(78, 6, COL_TXT);  gdCanvas.printf("%dx%d DISPLAY ONLY", g_width, g_rows);
  gdA(78, 16, COL_TXT);
  /* PAL:APP = アプリから受け取った糸色で描いている / PAL:DEF = 内蔵の既定色 (パレット未受信) */
  gdCanvas.printf("%dCOL %dPASS PAL:%s %dpx", g_passes < 2 ? 2 : g_passes, g_passes, g_hasPal ? "APP" : "DEF", markPx(g_width, g_flags));
  drawRowBig(38);                                  // 段を大きく (パスは右上の糸色見本、rev.38)
  drawCtrlLine(133);
  drawPassPanel();
}

/* 音量の表示 (接続待ちの画面。rev.41): 「音量」+ 10 段のバー + 「n/10」。y = 案内領域の座標 */
static void drawVolume(int y) {
  gdJ(6, y, COL_TXT, 1, "音量");
  const int x0 = 46, cw = 14, gap = 3, ch = 14;
  for (int i = 0; i < VOL_LEVELS; i++) {
    int x = x0 + i * (cw + gap);
    if (i < g_volLv) gdCanvas.fillRect(x, y + 1, cw, ch, COL_RUN);
    else             gdCanvas.drawRect(x, y + 1, cw, ch, COL_LINE);
  }
  char b[12];
  snprintf(b, sizeof(b), "%u/%u", g_volLv, VOL_LEVELS);
  gdJ(x0 + VOL_LEVELS * (cw + gap) + 6, y, COL_TXT, 1, b);
}
/* 接続待ちの画面のボタンの割当 (Core2。画面の下のボタンの位置に合わせて 3 つに分ける。rev.41) */
static void drawWaitButtons(int y) {
  const char* lab[3] = { "A 空通し", "B 音量－", "C 音量＋" };
  for (int i = 0; i < 3; i++) {
    int x0 = i * SCR_W / 3, x1 = (i + 1) * SCR_W / 3;
    gdCanvas.drawRect(x0 + 2, y, x1 - x0 - 4, 20, i ? COL_RDY : COL_LINE);
    gdJ(x0 + (x1 - x0 - gdW(1, lab[i])) / 2, y + 2, i ? COL_RDY : COL_TXT, 1, lab[i]);
  }
}

static void drawGuide() {
  gdCanvas.fillSprite(COL_BG);
  if (!g_carriage) { drawLegacyBody(); gdCanvas.pushSprite(0, GD_Y); return; }
  Snap s = snap();
  int8_t nx = nextMove(s);
  const char* lr  = nx < 0 ? "左へ" : "右へ";
  const char* end = g_side ? "左端" : "右端";
  char b[96];
  /* SRパタコン接続待ち: アプリ (編み機コントロール) がまだつないでいない。空通し待ちより前に出す。
     空通しが済んだあとに切れたときもここへ戻り、済んでいることを添える。
     空通し待ち (置いて動かす前) の間に切れたときもここへ戻る (rev.35)。つなぎ直すと空通し待ちの案内に戻る。
     本体の A・B ボタンで始めた空通し (アプリなし) と、往路・復路の途中はその案内を出す。
     接続待ちにするのは、起動直後と、SRパタコンの「切断」(BYE) か本体の A+C で切ったときだけ。
     BYE なしで切れたとき (ネットワーク等) は画面を変えず、その段階の案内のままにする (rev.37)。 */
  if (appWaiting()) {
    gdJ(6, 4, COL_RDY, 2, "SRパタコン接続待ち");
    gdJ(6, 40, COL_TXT, 1, "SRパタコンの編み機コントロールで");
    gdJ(6, 57, COL_TXT, 1, "この機器に接続してください");
    if (s.ok)                      gdJ(6, 73, COL_RUN, 1, "空通し済み (接続後すぐ送信できます)");
    else if (s.ph == ce::PH_PLACE) gdJ(6, 73, COL_STOP, 1, "空通しの途中で切断 (接続後に続けます)");
    else                           gdJ(6, 73, COL_LINE, 1, "接続したあとで空通しをします");
    gdA(6, 91, COL_LINE);
    if (WiFi.status() == WL_CONNECTED) gdCanvas.printf("ws://%s:%u  %s", WiFi.localIP().toString().c_str(), WS_PORT, g_cfg.host);
    else                               gdCanvas.print("WiFi disconnected");
    drawVolume(102);
    if (!g_btnBarH) drawWaitButtons(GD_H - 21);      // Core2: 画面の下のボタン A・B・C の割当 (CoreS3 は下のタッチボタンに出す)
    gdCanvas.pushSprite(0, GD_Y);
    return;
  }
  switch (s.ph) {
    case ce::PH_UNCAL:
      gdJ(6, 4, COL_RDY, 2, "空通し待ち");
      gdJ(6, 44, COL_TXT, 1, "SRパタコンで開始側を選んで「空通し」");
      snprintf(b, sizeof(b), "またはAボタン (開始側: %s)", end);
      gdJ(6, 64, COL_TXT, 1, b);
      gdA(6, 88, COL_LINE); gdCanvas.print("A:CALIBRATE B:SIDE C(hold):WiFi A+C(hold):BYE");
      break;
    case ce::PH_PLACE:
      gdJ(6, 4, COL_STOP, 2, "空通し");
      gdArrow(222, 6, 92, 30, nx, COL_STOP);
      snprintf(b, sizeof(b), "キャリッジを%sに置いて", end);
      gdJ(6, 44, COL_TXT, 1, b);
      snprintf(b, sizeof(b), "%s空通ししてください", nx < 0 ? "左へ" : "右へ");
      gdJ(6, 64, COL_TXT, 1, b);
      if (s.err) { snprintf(b, sizeof(b), "不一致: %s", calErrText(s.err)); gdJ(6, 84, COL_CLIP, 1, b); }
      break;
    case ce::PH_OUT: case ce::PH_BACK:
      gdJ(6, 4, COL_RUN, 2, s.ph == ce::PH_OUT ? "空通し 往路" : "空通し 復路");
      gdArrow(222, 6, 92, 30, nx, COL_RUN);
      snprintf(b, sizeof(b), s.ph == ce::PH_OUT ? "%s端まで動かしてください" : "%s戻してください",
               s.ph == ce::PH_OUT ? (nx < 0 ? "左" : "右") : lr);
      gdJ(6, 44, COL_TXT, 1, b);
      snprintf(b, sizeof(b), "針 %d  カム %u  カーソル %u", s.recN, s.recE, s.recC);
      gdJ(6, 64, COL_TXT, 1, b);
      break;
    case ce::PH_READY:
      gdJ(6, 4, COL_RUN, 2, "空通し完了");
      gdJ(6, 44, COL_TXT, 1, "SRパタコンでスタートを押してください");
      if (s.nwin > 1) snprintf(b, sizeof(b), "区間 %d〜%d / %d〜%d", s.lo[0], s.hi[0], s.lo[1], s.hi[1]);
      else            snprintf(b, sizeof(b), "区間 %d〜%d (%d目)  次は%s", s.lo[0], s.hi[0], s.hi[0] - s.lo[0] + 1, lr);
      gdJ(6, 64, COL_TXT, 1, b);
      gdA(6, 88, COL_LINE);
      gdCanvas.printf("OFF %d  CAM", s.off);
      for (int i = 0; i < s.ncam; i++) gdCanvas.printf(" %d", s.cam[i]);
      if (s.pc3) gdCanvas.print("  (PC3 ignored)");
      break;
    case ce::PH_KNIT: {
      /* 編み込み中 (rev.38): 向き (矢印と「左へ／右へ」) を上に、段を大きく (今の段は 3 倍)。
         パスは右上の糸色見本に 3 倍で出す。その下に状態・目数、最下行に制御ビット (ASCII) */
      uint16_t dc = g_moving ? COL_RUN : COL_RDY;
      gdArrow(6, 6, 64, 30, nx, dc);
      gdJ(80, 4, dc, 2, lr);
      drawRowBig(38);
      if      (s.warn & ce::W_SYNC)    gdJ(6, 96, COL_CLIP, 1, "位置ずれ: 空通しをやり直す");
      else if (s.warn & ce::W_NODATA)  gdJ(6, 96, COL_CLIP, 1, "データ待ち (平編みになった)");
      else if (s.warn & ce::W_PARTIAL) gdJ(6, 96, COL_CLIP, 1, "途中で折り返し (同じ段を再度)");
      else                             gdJ(6, 96, COL_RUN, 1, g_sending ? "編み込み中" : "送信待ち");
      int w = g_width * ((g_flags & KF_H2) ? 2 : 1);
      snprintf(b, sizeof(b), "目数 %d目  針 %d  編 %u", w, s.k, (unsigned)s.trav);
      gdJ(6, 114, COL_TXT, 1, b);
      drawCtrlLine(133);
      drawPassPanel();
      break;
    }
    default:
      gdJ(6, 4, COL_TXT, 2, "判定中");
      break;
  }
  gdCanvas.pushSprite(0, GD_Y);
}

static void drawHeader() {
  M5.Display.fillRect(0, 0, SCR_W, HDR_H, COL_BG);
  M5.Display.setFont(&fonts::Font0);
  M5.Display.setTextColor(COL_TXT, COL_BG);
  M5.Display.setTextSize(1);
  M5.Display.setCursor(4, 4);
  M5.Display.print("KNIT CTRL");
  M5.Display.setCursor(64, 4);
  if (WiFi.status() == WL_CONNECTED) M5.Display.printf("%s:%u %s", WiFi.localIP().toString().c_str(), WS_PORT, g_cfg.host);
  else                               M5.Display.print("WiFi disconnected");
  M5.Display.setCursor(250, 4);
  M5.Display.printf("CL:%d", g_clients);
  if (g_carriage) {
    M5.Display.setTextColor(COL_BG, g_side ? COL_RDY : COL_STOP);
    M5.Display.setCursor(284, 4);
    M5.Display.print(g_side ? " L " : " R ");
  }
  M5.Display.drawFastHLine(0, HDR_H - 1, SCR_W, COL_LINE);
}

// CoreS3: 画面の下のタッチボタン (A・B・C) の名前
static void drawButtonBar() {
  if (!g_btnBarH) return;
  int y = SCR_H - g_btnBarH;
  const char* lab[3] = { "A 空通し", g_side ? "B 開始側:左端" : "B 開始側:右端", "C 長押しWiFi" };
  if (!g_carriage) { lab[0] = "A 表示クリア"; lab[1] = ""; }
  else if (appWaiting()) { lab[1] = "B 音量－"; lab[2] = "C 音量＋"; }   // 接続待ちの画面では音量 (rev.41)
  M5.Display.fillRect(0, y, SCR_W, g_btnBarH, 0x18E3);
  M5.Display.setFont(&fonts::efontJA_16);
  M5.Display.setTextSize(1);
  for (int i = 0; i < 3; i++) {
    int x0 = i * SCR_W / 3, x1 = (i + 1) * SCR_W / 3;
    M5.Display.drawRect(x0, y, x1 - x0, g_btnBarH, COL_LINE);
    bool off = (i < 2 && g_sending);                        // 送信中は A・B を受け付けない
    M5.Display.setTextColor(off ? COL_LINE : COL_TXT);
    M5.Display.setCursor(x0 + 6, y + (g_btnBarH - 16) / 2);
    M5.Display.print(lab[i]);
  }
  M5.Display.setFont(&fonts::Font0);
}

void drawStatus() {
  drawHeader();
  drawGuide();
  M5.Display.drawFastHLine(0, PAT_Y - 2, SCR_W, COL_LINE);
  drawButtonBar();
}

// ---- 空通しと編み込みの制御 -----------------------------------------------------
static void startCalibration(uint8_t side) {
  g_side = side ? 1 : 0;
  g_appLost = false;                                     // 本体のボタンで始めたときはアプリなしで案内する
  saveSide(g_side);
  portENTER_CRITICAL(&g_mux);
  g_eng.stopKnit();
  g_eng.startCal(g_side);
  portEXIT_CRITICAL(&g_mux);
  onsOff();
  g_sending = false;
  g_voice.clear();
  g_voice.say(g_side ? V_PLACE_L : V_PLACE_R);
  g_dirty = true;
  sendStatus(true);
  Serial.printf("[CAL] start from %s end\n", g_side ? "LEFT" : "RIGHT");
}

// 空通しで検知したカーソル ("0 +1" のように、最初を 0 とした進行方向の目数) をシリアルへ
static void printCursors(const Snap& s) {
  for (int p = 0; p < 2; p++) {
    Serial.printf("%s", p ? " back:" : "[CAL] cursors out:");
    if (!s.curN[p]) Serial.print(" none");
    for (int i = 0; i < s.curN[p]; i++) { if (i) Serial.printf(" %+d", s.curRel[p][i - 1]); else Serial.print(" 0"); }
    if (s.curOvf[p]) Serial.print(" ...");
  }
  Serial.println();
}

static void evaluateCal() {
  portENTER_CRITICAL(&g_mux);
  uint8_t e = g_eng.evaluate();
  portEXIT_CRITICAL(&g_mux);
  Snap s = snap();
  printCursors(s);
  if (e == 0) {
    Serial.printf("[CAL] OK off=%d cams=%u win=%u pc3=%u\n", s.off, s.ncam, s.nwin, s.pc3);
    g_voice.say(V_CAL_OK);
    if (s.pc3) g_voice.say(V_PC3);
  } else {
    Serial.printf("[CAL] NG err=0x%02X\n", e);
    if (e & ce::E_NO_CURSOR)    g_voice.say(V_NO_CURSOR);
    if (e & ce::E_MULTI_CURSOR) g_voice.say(V_MULTI_CURSOR);
    if (e & ce::E_NO_CAM)       g_voice.say(V_NO_CAM);
    g_voice.say(V_CAL_NG);
    g_voice.say(g_side ? V_PLACE_L : V_PLACE_R);
  }
  g_dirty = true;
  sendStatus(true);
}

static void stopKnitting(bool say) {
  portENTER_CRITICAL(&g_mux);
  g_eng.stopKnit();
  portEXIT_CRITICAL(&g_mux);
  onsOff();
  if (g_sending && say) g_voice.say(V_STOPPED);
  g_sending = false;
  g_dirty = true;
}

static void sendAck(int row) {
  if (g_mainClient < 0) return;
  uint8_t ack[3] = { S2C_ACK, (uint8_t)(row & 0xff), (uint8_t)((row >> 8) & 0xff) };
  webSocket.sendBIN((uint8_t)g_mainClient, ack, sizeof(ack));
}

// 割り込みからのイベントを処理する (loop)
static void processEvents() {
  ce::Ev e;
  for (;;) {
    portENTER_CRITICAL(&g_mux);
    bool got = g_eng.pop(e);
    uint8_t ctrl = (got && e.type == ce::EV_BIND) ? g_eng.slot[g_eng.curSlot].ctrl : 0;
    portEXIT_CRITICAL(&g_mux);
    if (!got) break;
    switch (e.type) {
      case ce::EV_WRONG_DIR:  g_voice.say(V_WRONG_DIR); g_voice.say(g_side ? V_PLACE_L : V_PLACE_R); break;
      case ce::EV_BACK_START: g_voice.say(e.arg < 0 ? V_BACK_L : V_BACK_R); break;
      case ce::EV_CAL_END:    evaluateCal(); break;
      case ce::EV_TRAV:       if (VOICE_EACH_PASS && g_sending) g_voice.say(e.arg < 0 ? V_LEFT : V_RIGHT); break;
      case ce::EV_BIND:       if (ctrl & 8) M5.Speaker.tone(2000, 150, 1); break;   // ブザー (制御 bit3)
      case ce::EV_NODATA:     g_voice.say(V_NODATA); break;
      case ce::EV_DONE:       sendAck(e.arg); Serial.printf("[KNIT] done row %d -> ACK\n", e.arg); break;
      case ce::EV_DONE_HALF:  Serial.printf("[KNIT] row %d (V2 1st)\n", e.arg); break;
      case ce::EV_PARTIAL:    g_voice.say(V_PARTIAL); break;
      case ce::EV_SYNC:       g_voice.say(V_SYNC); break;
      default: break;
    }
    g_dirty = true;
  }
}

// キャリッジの動き (止まった / 空通しの復路の終わり) を見る (loop)
static void watchMotion() {
  if (!g_carriage) return;
  uint32_t now = millis(), tot = g_eng.inpTotal;
  if (tot != g_lastTot) {
    g_lastTot = tot; g_lastMoveMs = now;
    if (!g_moving) { g_moving = true; g_dirty = true; }
  } else if (g_moving && now - g_lastMoveMs > MOVE_IDLE_MS) {
    g_moving = false; g_dirty = true;
    portENTER_CRITICAL(&g_mux); g_eng.idle(); portEXIT_CRITICAL(&g_mux);
  }
  if (!g_moving && g_eng.phase == ce::PH_BACK && now - g_lastMoveMs > CAL_END_IDLE_MS) {
    portENTER_CRITICAL(&g_mux);
    bool ev = g_eng.endBackByIdle();
    portEXIT_CRITICAL(&g_mux);
    if (ev) evaluateCal();
  }
}

// ---- フレーム処理 -----------------------------------------------------------
static void sendNak(uint8_t num, int row, uint8_t code) {
  uint8_t nak[4] = { S2C_NAK, (uint8_t)(row & 0xff), (uint8_t)((row >> 8) & 0xff), code };
  webSocket.sendBIN(num, nak, sizeof(nak));
}

static void setMainClient(uint8_t num) {
  if (g_mainClient != (int)num) {
    bool lost = g_appLost;
    g_mainClient = num;
    g_appLost = false; g_linkDrop = false; g_byeClient = -1; g_lostWait = false;
    memset(g_lastStatus, 0xFF, sizeof(g_lastStatus));      // 新しい相手には必ず STATUS を送る
    if (g_carriage) {
      g_voice.say(V_CONNECT);
      if (lost && g_eng.phase == ce::PH_PLACE) g_voice.say(g_side ? V_PLACE_L : V_PLACE_R);   // 空通し待ちの続き
    }
    g_dirty = true;
  }
}

static void onModeEnter(uint8_t num, const uint8_t* p, size_t len) {
  if (len < MODE_ENTER_V1_LEN) { sendNak(num, NAK_NO_ROW, NAK_MODE_BAD); return; }
  int     w  = p[1] | (p[2] << 8);
  int     r  = p[3] | (p[4] << 8);
  uint8_t kf = p[5];
  int     n  = (len >= 7) ? p[6] : 1;                        // v1 は 1パス
  if (!validPassCount(n) || r < n || r % n != 0 || r > MAX_ROW * n) {
    sendNak(num, NAK_NO_ROW, NAK_MODE_BAD);
    Serial.printf("[MODE_ENTER] NAK rows=%d passes=%d\n", r, n);
    return;
  }
  if (w > MAX_STITCH) w = MAX_STITCH;
  setMainClient(num);
  /* 送信中に MODE_ENTER が来た = アプリがスタートし直した。編み込みはいったん止め、
     次の ROW_DATA で改めて始める (送信開始の案内もそこで出す) */
  if (g_carriage && g_sending) stopKnitting(false);

  // 寸法・パス数・変換が変わったら、パスバッファは使えない
  if (w != g_width || r != g_rows || n != g_passes || kf != g_flags) clearPassBuf();

  g_width = w; g_rows = r; g_flags = kf; g_passes = n;
  setPalette(len >= MODE_ENTER_V2_LEN ? p + 7 : nullptr);
  g_state = S_READY; g_lastRow = -1; g_lastPass = 0;
  resetPattern(); g_dirty = true;
  /* READY の版: キャリッジ制御 (CALIB / STATUS) があるときだけ 3。アプリは 3 以上なら空通しを求める */
  uint8_t out[2] = { S2C_READY, g_carriage ? PROTO_VER : PROTO_VER_DISPLAY };
  webSocket.sendBIN(num, out, sizeof(out));
  sendStatus(true);
  Serial.printf("[MODE_ENTER] %dx%d passes=%d pal=%s flags=0x%02X -> READY v%u\n",
                g_width, g_rows, g_passes, g_hasPal ? "yes" : "no", g_flags, out[1]);
}

static void onRowData(uint8_t num, const uint8_t* p, size_t len) {
  if (len < 8) return;
  int     row   = p[1] | (p[2] << 8);
  uint8_t kf    = p[3];
  uint8_t ctrl  = p[4] & 0x0f;
  uint8_t dir   = p[5];
  int     width = p[6] | (p[7] << 8);
  const uint8_t* bits = p + 8;
  int need = (width + 7) >> 3;
  int n    = g_passes;

  if (width < 1 || width > MAX_STITCH || row < 0 || row >= MAX_ROW * n ||
      (g_rows > 0 && row >= g_rows) || (int)len < 8 + need) {  // 破損 / 範囲外 → NAK
    sendNak(num, row, NAK_ROW_BAD);
    Serial.printf("[ROW_DATA] NAK row=%d width=%d len=%u\n", row, width, (unsigned)len);
    return;
  }

  // パス番号・色番号: 段位置から求め、v2 の追記があれば照合する
  int pno = passOfIdx(row, n, dir), cno = passColorNo(pno, n);
  if ((int)len >= 8 + need + 2) {
    int rp = p[8 + need], rc = p[9 + need];
    if (rp != pno || rc != cno) {
      sendNak(num, row, NAK_PASS_BAD);
      Serial.printf("[ROW_DATA] NAK row=%d pass=%d/%d color=%d (expected pass=%d color=%d)\n",
                    row, rp, n, rc, pno, cno);
      return;
    }
  }

  /* キャリッジ制御: 空通しが済んでいなければ編めない (NAK 4)。アプリは空通しが済むまでスタートさせない */
  if (g_carriage) {
    setMainClient(num);
    uint8_t ph = g_eng.phase;
    if (!g_eng.cal.ok || (ph != ce::PH_READY && ph != ce::PH_KNIT)) {
      sendNak(num, row, NAK_UNCAL);
      if (millis() - g_needCalSaidMs > 5000) { g_needCalSaidMs = millis(); g_voice.say(V_NEED_CAL); }
      Serial.printf("[ROW_DATA] NAK row=%d (not calibrated)\n", row);
      return;
    }
  }

  int design     = row / n;                                  // デザイン段の内部添字 (上端 = 0)
  int designRows = g_rows > 0 ? g_rows / n : 0;

  bool colorChanged = (g_lastPass > 0 && cno != g_lastColor);
  g_state = S_RUN;
  g_lastRow = row; g_lastCtrl = ctrl; g_lastDir = dir; g_flags = kf; g_width = width;
  g_lastPass = pno; g_lastColor = cno;
  g_lastDesignNo = designRows > 0 ? designRows - design : 0; // 表示段 = R − i (段1 = 最下段)

  // パスバッファ (合成図用)。パス1 か別のデザイン段が来たら貯め直す。
  if (pno == 1 || design != g_bufDesign || width != g_bufWidth) {
    clearPassBuf(); g_bufDesign = design; g_bufWidth = width;
  }
  memcpy(g_passBits[pno - 1], bits, need);
  g_passHave[pno - 1] = true;

  drawDesignBand(design, width, pno, kf);                   // ← 受信データを LCD へ
  if (BEEP_ON_COLOR_CHANGE && n >= 2 && colorChanged) M5.Speaker.tone(2000, 60, 1);
  g_dirty = true;

  if (g_carriage) {
    /* 次のトラバースで選針するパスとして置く。ACK は編み終えたとき (processEvents の EV_DONE)。
       縦2倍は同じパスで 2 回編んでから ACK (多色も パス1×2 → パス2×2 … → パスN×2)。 */
    bool first = !g_sending;
    portENTER_CRITICAL(&g_mux);
    if (first) g_eng.startKnit();
    g_eng.arm(bits, width, (kf & KF_H2) ? 1 : 0, (kf & KF_V2) ? 2 : 1, (uint16_t)row, ctrl, (uint8_t)pno, (uint8_t)cno);
    portEXIT_CRITICAL(&g_mux);
    if (first) {                                             // 送信開始 → 編み込みの開始を案内
      g_sending = true;
      Snap s = snap();
      g_voice.say(nextMove(s) < 0 ? V_START_L : V_START_R);
      Serial.printf("[KNIT] start (row %d)\n", row);
    }
    sendStatus(true);
    return;
  }

  knitPass(bits, width, ctrl, pno, cno, kf, false);
  if (kf & KF_V2)                                            // 縦2倍: 同じパスをもう一度編んでから ACK
    knitPass(bits, width, ctrl, pno, cno, kf, true);         //   (多色も パス1×2 → パス2×2 … → パスN×2)

  // 表示専用は即 ACK。段番号は受信値をそのまま返す。
  uint8_t ack[3] = { S2C_ACK, (uint8_t)(row & 0xff), (uint8_t)(row >> 8) };
  webSocket.sendBIN(num, ack, sizeof(ack));
}

static void onStop(uint8_t num) {
  g_state = S_STOPPED; g_dirty = true;
  if (g_carriage) { setMainClient(num); stopKnitting(true); }
  uint8_t out[1] = { S2C_STOPPED };
  webSocket.sendBIN(num, out, sizeof(out));
  sendStatus(true);
  Serial.println("[STOP] -> STOPPED");
}

// CALIB [04][開始側 0=右端 / 1=左端]: 空通しを始める (proto v3)
static void onCalib(uint8_t num, const uint8_t* p, size_t len) {
  if (!g_carriage) return;                                   // 表示専用 (v2) では使わない
  setMainClient(num);
  startCalibration((len >= 2 && p[1]) ? 1 : 0);
}

static void onHello(uint8_t num) {
  IPAddress ip = webSocket.remoteIP(num);   // 接続元 = ブラウザの LAN IP
  uint8_t buf[5 + 40]; int n = 0;
  buf[n++] = S2C_INFO;
  buf[n++] = ip[0]; buf[n++] = ip[1]; buf[n++] = ip[2]; buf[n++] = ip[3];
  for (const char* h = g_cfg.host; *h && n < (int)sizeof(buf); ++h) buf[n++] = (uint8_t)*h;
  webSocket.sendBIN(num, buf, n);
  Serial.printf("[HELLO] -> INFO client=%s host=%s\n", ip.toString().c_str(), g_cfg.host);
}

/* 生存確認 (rev.42。仕様書 7.4)。WS_PING_INTERVAL_MS ごとに全クライアントへ ping を送り、
   最後に応答 (pong・フレーム) があった時刻から、送信相手は LINK_TIMEOUT_MS (10 分)、それ以外は
   PROBE_TIMEOUT_MS で切る。切ると WStype_DISCONNECTED が来て、BYE なしの切断として扱う
   (送信中なら編み込みを止める。警告の音声 24)。ブラウザは ping に自動で pong を返すので、
   タブを裏にしていても応答する。タブレットがスリープすると応答がなくなる。 */
bool     g_wsOn[WS_SLOTS];             // つながっている
bool     g_wsKill[WS_SLOTS];           // 応答がなくてこちらから切った (続く切断の通知で使う)
uint32_t g_wsSeen[WS_SLOTS];           // 最後に応答があった時刻
static void wsSeen(uint8_t num) { if (num < WS_SLOTS) g_wsSeen[num] = millis(); }
static void wsHeartbeat() {
  static uint32_t lastPing = 0;
  uint32_t now = millis();
  /* BYE なしで切れたまま (タブレットのブラウザが接続を閉じた等) LINK_TIMEOUT_MS たったら警告する */
  if (g_lostWait && now - g_lostMs >= LINK_TIMEOUT_MS) {
    g_lostWait = false;
    if (g_carriage && g_mainClient < 0) { g_voice.say(V_LINK_LOST); Serial.println("[WS] SR-PataCon not back -> warn (voice 24)"); }
  }
  for (uint8_t i = 0; i < WS_SLOTS; i++) {
    if (!g_wsOn[i]) continue;
    bool isMain = ((int)i == g_mainClient);
    if (now - g_wsSeen[i] > (isMain ? LINK_TIMEOUT_MS : PROBE_TIMEOUT_MS)) {
      Serial.printf("[WS] #%u no response for %lus -> disconnect%s\n", i, (unsigned long)((now - g_wsSeen[i]) / 1000),
                    isMain ? " (SR-PataCon)" : "");
      g_wsOn[i] = false;                           // 切断の通知が来なくても二度は切らない
      g_wsKill[i] = true;
      webSocket.disconnect(i);
    }
  }
  if (now - lastPing < WS_PING_INTERVAL_MS) return;
  lastPing = now;
  for (uint8_t i = 0; i < WS_SLOTS; i++) if (g_wsOn[i]) webSocket.sendPing(i);
}

// BYE [05]: SRパタコンの「切断」・閉じる。続く切断は意図したもの (「SRパタコン接続待ち」にする)
static void onBye(uint8_t num) {
  if ((int)num == g_mainClient) g_byeClient = num;
  Serial.printf("[BYE] #%u\n", num);
}

void webSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      g_clients++; g_dirty = true;
      if (num < WS_SLOTS) { g_wsOn[num] = true; g_wsKill[num] = false; wsSeen(num); }
      if (!g_sending) g_state = S_WAIT;
      Serial.printf("[WS] connected #%u (clients=%d)\n", num, g_clients);
      break;
    case WStype_DISCONNECTED: {
      if (g_clients > 0) g_clients--;
      bool timedOut = num < WS_SLOTS && g_wsKill[num];
      if (num < WS_SLOTS) { g_wsOn[num] = false; g_wsKill[num] = false; }
      /* 送信相手が切れたら編み込みを止める (古いデータで選針し続けないため)。
         ・BYE のあとの切断 (SRパタコンの「切断」・閉じる): 空通し待ち・空通し完了などの待機中は
           「SRパタコン接続待ち」の画面にする (rev.35)。空通し待ちなら、まだ鳴らしていない置き場所の案内を
           捨てる (つなぎ直したらもう一度案内する)。接続待ちになったら音声 23 で知らせる (rev.42)。
         ・BYE なしの切断 (ネットワーク等): 画面は変えず、再接続を促す表示も出さない (rev.37)。
           応答が LINK_TIMEOUT_MS (10 分) 途絶えてこちらから切ったときは音声 24 で警告する。
           相手が閉じたとき (タブレットのブラウザが閉じた等) は、そこから 10 分つなぎ直さなければ警告する (rev.42) */
      if ((int)num == g_mainClient) {
        bool bye = (g_byeClient == (int)num);
        g_mainClient = -1; g_byeClient = -1; g_lostWait = false;
        if (g_carriage && !bye && timedOut) g_voice.say(V_LINK_LOST);
        if (g_carriage && g_sending) stopKnitting(true);
        if (bye) {
          g_appLost = true; g_linkDrop = false;
          if (g_carriage && g_eng.phase == ce::PH_PLACE) g_voice.clear();
          if (appWaiting()) g_voice.say(V_WAIT_APP);
        } else {
          g_linkDrop = true;
          if (!timedOut) { g_lostWait = true; g_lostMs = millis(); }
        }
        Serial.printf("[WS] app %s (phase %u)\n", bye ? "closed (BYE) -> waiting for SR-PataCon"
                      : timedOut ? "timed out (no BYE) -> keep screen, warn" : "link dropped (no BYE) -> keep screen",
                      (unsigned)g_eng.phase);
      }
      if (g_clients == 0) g_state = S_WAIT;
      g_dirty = true;
      Serial.printf("[WS] disconnected #%u (clients=%d)\n", num, g_clients);
      break;
    }
    case WStype_PING:
    case WStype_PONG:
    case WStype_TEXT:
      wsSeen(num);
      break;
    case WStype_BIN:
      wsSeen(num);
      if (length < 1) break;
      switch (payload[0]) {
        case C2S_MODE_ENTER: onModeEnter(num, payload, length); break;
        case C2S_ROW_DATA:   onRowData(num, payload, length);   break;
        case C2S_STOP:       onStop(num);                        break;
        case C2S_CALIB:      onCalib(num, payload, length);      break;
        case C2S_HELLO:      onHello(num);                       break;
        case C2S_BYE:        onBye(num);                         break;
        default: break;
      }
      break;
    default: break;
  }
}

// ---- WiFi 設定ポータル --------------------------------------------------------
// 本体を AP にして設定ページを出す。保存またはタイムアウトで再起動するので戻らない。
static String htmlEsc(const String& in) {
  String o; o.reserve(in.length() + 8);
  for (size_t i = 0; i < in.length(); i++) {
    char c = in[i];
    if      (c == '&')  o += "&amp;";
    else if (c == '<')  o += "&lt;";
    else if (c == '>')  o += "&gt;";
    else if (c == '"')  o += "&quot;";
    else if (c == '\'') o += "&#39;";
    else                o += c;
  }
  return o;
}

static bool validHost(const char* h) {
  size_t n = strlen(h);
  if (n < 1 || n > 32 || h[0] == '-' || h[n - 1] == '-') return false;
  for (size_t i = 0; i < n; i++) {
    char c = h[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
  }
  return true;
}

static const int PORTAL_MAX_NETS = 20;
static String g_netOptions;                         // 検索した SSID の <option> 群

static void scanNetworks() {
  // AP を保ったままでも検索できるが、接続中の端末が一瞬切れることがある
  int n = WiFi.scanNetworks();
  String opts; int shown = 0;
  for (int i = 0; i < n && shown < PORTAL_MAX_NETS; i++) {
    String ssid = WiFi.SSID(i);
    if (!ssid.length()) continue;                   // ステルス
    bool dup = false;                               // 同名 (メッシュ等) は最初の 1 件 = 最強のみ
    for (int j = 0; j < i; j++) if (WiFi.SSID(j) == ssid && WiFi.RSSI(j) >= WiFi.RSSI(i)) { dup = true; break; }
    if (dup) continue;
    String e = htmlEsc(ssid);
    opts += "<option value=\"" + e + "\">" + e + " (" + String(WiFi.RSSI(i)) + "dBm" +
            (WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? ", open" : "") + ")</option>";
    shown++;
  }
  WiFi.scanDelete();
  g_netOptions = opts;
}

static const char PORTAL_CSS[] PROGMEM =
  "body{font-family:system-ui,sans-serif;background:#12141a;color:#d7dbe2;margin:0;padding:16px}"
  "main{max-width:420px;margin:auto}h1{font-size:18px;color:#f5a623;margin:4px 0 12px}"
  "label{display:block;margin:14px 0 4px;font-size:13px;color:#aab2bf}"
  "input,select,button{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border-radius:6px;"
  "border:1px solid #333a46;background:#232833;color:#e6e9ee}"
  "button{background:#2fa968;border:0;color:#fff;font-weight:bold;margin-top:18px}"
  ".sub{background:#333a46;font-weight:normal;margin-top:10px}"
  ".chk{display:flex;gap:8px;align-items:center;margin-top:8px;font-size:13px}.chk input{width:auto}"
  ".note{font-size:12px;color:#8b93a1}.err{color:#ff6b6b;font-size:14px}.ok{color:#2fa968;font-size:15px}";

static String portalPage(const String& msg, bool isErr) {
  String h;
  h.reserve(3000 + g_netOptions.length());
  h += F("<!doctype html><html lang=ja><meta charset=utf-8>"
         "<meta name=viewport content='width=device-width,initial-scale=1'>"
         "<title>KnitCtrl WiFi設定</title><style>");
  h += FPSTR(PORTAL_CSS);
  h += F("</style><main><h1>&#9626; KnitCtrl WiFi 設定</h1>");
  if (msg.length()) h += String("<p class=") + (isErr ? "err" : "ok") + ">" + htmlEsc(msg) + "</p>";
  h += F("<p class=note>本体に保存した接続先: ");
  h += g_cfg.ssid[0] ? htmlEsc(g_cfg.ssid) : String("(なし)");
  h += F("<br>SD カード wifi.cnf: ");
  if (g_sd.state == SDW_OK)          h += htmlEsc(g_sd.ssid);
  else if (g_sd.state == SDW_BAD)    h += F("形式が不正 (既定の SilverReed を使用)");
  else if (g_sd.state == SDW_NO_FILE) h += F("なし (既定の SilverReed を使用)");
  else                               h += F("SD カードなし (既定の SilverReed を使用)");
  h += F("<br>起動時は 本体に保存した接続先 → wifi.cnf の順に試します。wifi.cnf を書き換えると、"
         "本体に保存した接続先は消えて wifi.cnf が使われます。");
  h += F("</p><form method=post action=/save><label>ネットワーク (SSID)</label>"
         "<select onchange=\"if(this.value)document.getElementById('s').value=this.value\">"
         "<option value=''>一覧から選ぶ…</option>");
  h += g_netOptions;
  h += F("</select><input id=s name=ssid maxlength=32 required placeholder='SSID を入力' value=\"");
  h += htmlEsc(g_cfg.ssid);
  h += F("\"><label>パスワード</label><input name=pass type=password maxlength=63 autocomplete=off placeholder='");
  h += g_cfg.pass[0] ? F("保存済み (変更するときだけ入力)") : F("8〜63文字");
  h += F("'><div class=chk><input type=checkbox name=open id=o><label for=o style='margin:0'>パスワードなし (オープン)</label></div>"
         "<label>ホスト名 (アプリの機器一覧に表示)</label><input name=host maxlength=32 required "
         "pattern='[A-Za-z0-9]([A-Za-z0-9\\-]*[A-Za-z0-9])?' value=\"");
  h += htmlEsc(g_cfg.host);
  h += F("\"><button>保存して再起動</button></form>"
         "<form method=post action=/rescan><button class=sub>ネットワークを再検索</button></form>"
         "<form method=post action=/clear onsubmit=\"return confirm('保存した設定を消去しますか？')\">"
         "<button class=sub>設定を消去</button></form>"
         "<p class=note>WebSocket ポート 21075 / 保存すると本体が再起動して接続します。</p></main>");
  return h;
}

static void drawPortalScreen(const char* apSsid, const char* apPass, const char* reason) {
  M5.Display.fillScreen(COL_BG);
  M5.Display.setTextColor(COL_STOP, COL_BG);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 6);
  M5.Display.print("WiFi SETUP");
  M5.Display.setTextSize(1);
  M5.Display.setTextColor(COL_LINE, COL_BG);
  M5.Display.setCursor(6, 28);
  M5.Display.print(reason);

  M5.Display.setTextColor(COL_TXT, COL_BG);
  M5.Display.setCursor(6, 50);  M5.Display.print("1. Join this WiFi:");
  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 62);  M5.Display.print(apSsid);
  M5.Display.setTextSize(1);
  M5.Display.setCursor(6, 84);  M5.Display.print("   password:");
  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 96);  M5.Display.print(apPass);
  M5.Display.setTextSize(1);
  M5.Display.setCursor(6, 122); M5.Display.print("2. Setup page opens.");
  M5.Display.setCursor(6, 134); M5.Display.print("   If not, browse:");
  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 146); M5.Display.print("192.168.4.1");
  M5.Display.setTextSize(1);
  M5.Display.setTextColor(COL_LINE, COL_BG);
  M5.Display.setCursor(6, 184); M5.Display.printf("SD: %s", sdStateText());
  M5.Display.setCursor(6, 196); M5.Display.print(g_btnBarH ? "touch bottom-left (A): retry" : "BtnA: retry connect");
  M5.Display.setCursor(6, 208); M5.Display.printf("auto retry in %lu min", (unsigned long)(PORTAL_IDLE_RESTART_MS / 60000));
  // スマホのカメラで読むと AP に接続できる QR (WIFI:T:WPA;S:..;P:..;;)
  char qr[96];
  snprintf(qr, sizeof(qr), "WIFI:T:WPA;S:%s;P:%s;;", apSsid, apPass);
  M5.Display.fillRect(170, 36, 148, 148, COL_TXT);           // 白い余白 (クワイエットゾーン 4 セル以上)
  M5.Display.qrcode(qr, 180, 46, 128);
  M5.Display.setTextColor(COL_TXT, COL_BG);
  M5.Display.setCursor(208, 190); M5.Display.print("scan to join");
}

static void portalMessage(const char* line) {
  M5.Display.fillRect(0, 222, SCR_W, 18, COL_BG);
  M5.Display.setTextColor(COL_RUN, COL_BG);
  M5.Display.setTextSize(1);
  M5.Display.setCursor(6, 228);
  M5.Display.print(line);
}

static void runPortal(const char* reason) {
  Serial.printf("[PORTAL] %s\n", reason);

  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA);                           // STA は検索用
  delay(100);

  uint64_t mac = ESP.getEfuseMac();
  char apSsid[20], apPass[9];
  snprintf(apSsid, sizeof(apSsid), "KnitCtrl-%02X%02X", (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  snprintf(apPass, sizeof(apPass), "%08lu", (unsigned long)(esp_random() % 100000000UL)); // 起動ごとに変わる

  scanNetworks();
  WiFi.softAP(apSsid, apPass);
  delay(100);
  IPAddress apIP = WiFi.softAPIP();                 // 192.168.4.1

  DNSServer dns;
  dns.setErrorReplyCode(DNSReplyCode::NoError);
  dns.start(53, "*", apIP);                         // どの名前も本体へ = キャプティブポータル
  WebServer server(80);

  uint32_t lastActive = millis();
  uint32_t restartAt  = 0;

  server.on("/", HTTP_GET, [&]() {
    lastActive = millis();
    server.send(200, "text/html; charset=utf-8", portalPage("", false));
  });
  server.on("/save", HTTP_POST, [&]() {
    lastActive = millis();
    NetConfig c = g_cfg;
    String ssid = server.arg("ssid"), pass = server.arg("pass"), host = server.arg("host");
    bool open = server.hasArg("open");
    host.trim(); host.toLowerCase();
    String err;
    if (ssid.length() < 1 || ssid.length() > 32)            err = "SSID は1〜32バイトで入力してください";
    else if (!open && pass.length() == 0 && ssid != g_cfg.ssid) err = "パスワードを入力してください (オープンならチェック)";
    else if (!open && pass.length() > 0 && (pass.length() < 8 || pass.length() > 63))
                                                              err = "パスワードは8〜63文字です";
    else if (!validHost(host.c_str()))                        err = "ホスト名は英小文字・数字・ハイフン (1〜32文字) です";
    if (err.length()) { server.send(200, "text/html; charset=utf-8", portalPage(err, true)); return; }

    strlcpy(c.ssid, ssid.c_str(), sizeof(c.ssid));
    if (open)                  c.pass[0] = 0;
    else if (pass.length() > 0) strlcpy(c.pass, pass.c_str(), sizeof(c.pass));
    // パスワード空 & 同じ SSID → 保存済みのパスワードをそのまま使う
    strlcpy(c.host, host.c_str(), sizeof(c.host));
    if (!saveConfig(c)) { server.send(200, "text/html; charset=utf-8", portalPage("保存に失敗しました", true)); return; }
    g_cfg = c;
    server.send(200, "text/html; charset=utf-8",
                portalPage(String("保存しました。再起動して「") + c.ssid + "」に接続します。"
                           "このページは閉じてかまいません。", false));
    portalMessage("SAVED. restarting...");
    Serial.printf("[PORTAL] saved ssid=%s host=%s\n", c.ssid, c.host);
    restartAt = millis() + 1500;
  });
  server.on("/rescan", HTTP_POST, [&]() {
    lastActive = millis();
    scanNetworks();
    server.sendHeader("Location", "/");
    server.send(303);
  });
  server.on("/clear", HTTP_POST, [&]() {
    clearConfig();
    loadConfig();
    server.send(200, "text/html; charset=utf-8", portalPage("設定を消去しました。再起動します。", false));
    portalMessage("CLEARED. restarting...");
    restartAt = millis() + 1500;
  });
  server.onNotFound([&]() {                         // OS の接続確認 URL などはすべて設定ページへ
    server.sendHeader("Location", String("http://") + apIP.toString() + "/");
    server.send(302, "text/plain", "");
  });
  server.begin();

  drawPortalScreen(apSsid, apPass, reason);

  for (;;) {
    dns.processNextRequest();
    server.handleClient();
    M5.update();
    if (WiFi.softAPgetStationNum() > 0) lastActive = millis();
    if (restartAt && (int32_t)(millis() - restartAt) >= 0) break;
    if (!restartAt) {
      if (M5.BtnA.wasPressed()) { portalMessage("retry connect..."); delay(300); break; }
      if (millis() - lastActive > PORTAL_IDLE_RESTART_MS) break;   // 放置 → 再起動して再接続
    }
    delay(2);
  }
  server.stop();
  dns.stop();
  ESP.restart();
}

// USB シリアルで "setup" を受けたらポータル
static bool serialSetupRequested() {
  static char line[16]; static int n = 0;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r' || c == '\n') {
      line[n] = 0; n = 0;
      if (strcmp(line, "setup") == 0) return true;
    } else if (n < (int)sizeof(line) - 1) {
      line[n++] = c;
    }
  }
  return false;
}

// ---- setup / loop -----------------------------------------------------------
void setup() {
  auto cfg = M5.config();
  /* 電源は M-Bus の 5V からインタフェース基板と共有で受ける。本体の 5V 出力 (Core2: AXP の昇圧と
     EXTEN / Core2 v1.1: BLDO2 / CoreS3: AW9523 の BUS_OUT_EN) を切り、外からの 5V を入力にする。 */
  cfg.output_power = !MBUS_5V_INPUT;
  M5.begin(cfg);
  M5.Speaker.begin();
  g_volLv = loadVol();                               // 保存した音量 (なければ 8/10。rev.41)
  applyVol();
  /* CoreS3 には A・B・C のボタンがない。画面の下 BTNBAR_H を左・中・右のタッチボタンにする
     (M5Unified が BtnA/B/C として扱う)。Core2 は画面の外のタッチボタンをそのまま使う。 */
  {
    auto bd = M5.getBoard();
    if (bd == m5::board_t::board_M5StackCoreS3 || bd == m5::board_t::board_M5StackCoreS3SE) {
      g_btnBarH = BTNBAR_H;
      M5.setTouchButtonHeight(BTNBAR_H);
      PAT_H = SCR_H - PAT_Y - BTNBAR_H;
    }
  }
  g_carriage = setupCarriageIo();                    // 選針出力は最初に平編み (H) にする
  M5.Display.setRotation(1);
  M5.Display.fillScreen(COL_BG);
  M5.Display.setTextColor(COL_TXT, COL_BG);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 8);
  M5.Display.print("KNIT CTRL");

  setPalette(nullptr);
  clearPassBuf();
  for (int x = 0; x < MAX_STITCH; x++) g_compo[x] = COMPO_EMPTY;

  // 接続先: SD の wifi.cnf を読み、NVS の保存値と合わせて候補を作る
  readSdWifi();
  applySdChange();                                   // wifi.cnf が書き換わっていれば NVS の接続先を消す
  loadConfig();
  buildCandidates();
  g_side = loadSide();                               // 空通しの開始側 (前回の設定)
  g_eng.startSide = g_side; g_eng.expectDir = g_side ? 1 : -1;

  // 起動時に A ボタンを押していれば設定ポータル (CoreS3 は画面の左下を押したまま)
  if (g_btnBarH) {
    M5.Display.setTextSize(1);
    M5.Display.setCursor(6, SCR_H - 12);
    M5.Display.print("hold bottom-left (A): WiFi setup");
  }
  for (int i = 0; i < 10; i++) {
    M5.update();
    if (M5.BtnA.isPressed()) runPortal("requested: BtnA at boot");
    delay(30);
  }

  // パターン用スプライト (PSRAM 搭載機は PSRAM を使用)
  if (psramFound()) patCanvas.setPsram(true);
  patCanvas.setColorDepth(16);
  patCanvas.setBaseColor(COL_BG);
  if (!patCanvas.createSprite(SCR_W, PAT_H)) {
    // 低 RAM 機で確保失敗した場合は色深度を落とす
    patCanvas.setColorDepth(8);
    patCanvas.createSprite(SCR_W, PAT_H);
  }
  // 案内用スプライト
  if (psramFound()) gdCanvas.setPsram(true);
  gdCanvas.setColorDepth(16);
  if (!gdCanvas.createSprite(SCR_W, GD_H)) {
    gdCanvas.setColorDepth(8);
    gdCanvas.createSprite(SCR_W, GD_H);
  }

  M5.Display.setTextSize(1);
  M5.Display.setCursor(6, 34);
  M5.Display.printf("SD: %s", sdStateText());
  M5.Display.setCursor(6, 76);
  M5.Display.print("hold A: WiFi setup");

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(g_cfg.host);
  bool connected = false;
  for (int t = 0; t < WIFI_TRIES && !connected; t++) {
    const WifiCand& c = g_cands[t % g_nCands];       // 候補が 2 つなら交互
    M5.Display.fillRect(0, 48, SCR_W, 24, COL_BG);
    M5.Display.setCursor(6, 48);
    M5.Display.printf("WiFi try %d/%d [%s]", t + 1, WIFI_TRIES, c.src);
    M5.Display.setCursor(6, 60);
    M5.Display.printf("%.40s ", c.ssid);
    Serial.printf("[WiFi] try %d/%d %s (%s)\n", t + 1, WIFI_TRIES, c.ssid, c.src);

    WiFi.disconnect();
    delay(100);
    WiFi.begin(c.ssid, c.pass[0] ? c.pass : nullptr);
    uint32_t t0 = millis();
    while (millis() - t0 < WIFI_TRY_TIMEOUT_MS) {
      if (WiFi.status() == WL_CONNECTED) { connected = true; break; }
      M5.update();
      if (M5.BtnA.isPressed()) runPortal("requested: BtnA");
      if ((millis() - t0) % 500 < 50) M5.Display.print(".");
      delay(50);
    }
  }

  if (!connected) {
    Serial.printf("[WiFi] connect failed (%d tries)\n", WIFI_TRIES);
    runPortal("WiFi connect failed");                // 戻らない
  }
  WiFi.setAutoReconnect(true);
  MDNS.begin(g_cfg.host);
  MDNS.addService("ws", "tcp", WS_PORT);
  Serial.printf("[WiFi] %s  ws://%s.local:%u\n",
                WiFi.localIP().toString().c_str(), g_cfg.host, WS_PORT);

  M5.Display.fillScreen(COL_BG);
  patCanvas.fillSprite(COL_BG);
  patCanvas.pushSprite(0, PAT_Y);

  webSocket.begin();
  /* 応答のない古いクライアントスロットは wsHeartbeat (loop) が回収する (仕様書 7.4)。
     回収しないと WebSocketsServer はスロットを自動解放せず、アプリが /24 探索を
     繰り返したあとに本接続できなくなる。rev.41 まではライブラリのハートビート
     (ping 15s / pong 待ち 3s / 連続失敗 2 回で切断) を全クライアントに使っていた。 */
  webSocket.onEvent(webSocketEvent);

  g_dirty = true;
  drawStatus();
  if (g_carriage) g_voice.say(V_BOOT);
  Serial.printf("[BOOT] carriage=%s side=%s sd=%s\n", g_carriage ? "on" : "off (display only)",
                g_side ? "LEFT" : "RIGHT", g_sdMounted ? "yes" : "no");
}

/* 本体の A+C 長押し: SRパタコンとのリンクを切る (rev.37)。切断要求 [85] を送り、すぐ「SRパタコン接続待ち」にする。
   SRパタコンは [85] を受けると BYE を返して閉じ、パターン表示に戻る。閉じない相手 (古いアプリ・探索のプローブ) は
   KICK_WAIT_MS 後にこちらから切る。送信中なら編み込みを止める。 */
static void kickApp() {
  bool had = g_mainClient >= 0, was = appWaiting();
  if (g_carriage && g_sending) stopKnitting(true);
  uint8_t f[1] = { S2C_BYE };
  webSocket.broadcastBIN(f, sizeof(f));
  g_byeClient = -1;
  g_mainClient = -1;                               // 以後の切断は送信相手の切断として扱わない
  g_appLost = true; g_linkDrop = false;
  g_lostWait = false;
  if (g_carriage && g_eng.phase == ce::PH_PLACE) g_voice.clear();
  if (g_carriage && (had || !was) && appWaiting()) g_voice.say(V_WAIT_APP);   // 接続待ちになった (rev.42)
  g_kick = true; g_kickMs = millis();
  M5.Speaker.tone(1200, 80, 1);
  g_dirty = true;
  Serial.printf("[KICK] A+C: disconnect request sent (clients=%d)\n", g_clients);
}

/* 本体のボタン。A は離したときに働く (C と同時に押したときは働かない)。A+C 長押しでリンクを切る。
   C 長押し (A を押していない) は設定ポータル。 */
static void handleButtons() {
  static uint32_t comboMs = 0, cDownMs = 0;
  static bool combo = false, comboUsed = false, comboFired = false;
  bool a = M5.BtnA.isPressed(), c = M5.BtnC.isPressed();
  if (M5.BtnC.wasPressed()) cDownMs = millis();
  if (a && c) {
    if (!combo) { combo = true; comboMs = millis(); }
    comboUsed = true;
    if (!comboFired && millis() - comboMs >= KICK_HOLD_MS) { comboFired = true; kickApp(); }
  } else combo = false;
  bool aClick = M5.BtnA.wasReleased() && !comboUsed;
  /* C を短く押して離した (長押しのポータル・A+C ではない) */
  bool cClick = M5.BtnC.wasReleased() && !comboUsed && millis() - cDownMs < PORTAL_HOLD_MS;
  bool waiting = appWaiting();
  if (g_carriage && waiting) {
    /* SRパタコン接続待ち: A = 空通し / B = 音量を下げる / C = 音量を上げる (rev.41) */
    if (aClick) startCalibration(g_side);
    if (M5.BtnB.wasPressed()) stepVol(-1);
    if (cClick) stepVol(+1);
  } else if (g_carriage) {
    // A: 空通しを始める / B: 空通しの開始側を切り替える (送信中は受け付けない)
    if (aClick && !g_sending) startCalibration(g_side);
    if (M5.BtnB.wasPressed() && !g_sending) {
      uint8_t ph = g_eng.phase;
      if (ph != ce::PH_OUT && ph != ce::PH_BACK && ph != ce::PH_EVAL) {
        g_side ^= 1;
        if (ph == ce::PH_PLACE) startCalibration(g_side);
        else { saveSide(g_side); g_dirty = true; sendStatus(true); }
      }
    }
  } else if (aClick) {
    resetPattern();                                // 表示専用: A = 表示クリア
  }
  bool portal = (M5.BtnC.pressedFor(PORTAL_HOLD_MS) && !comboUsed) || serialSetupRequested();
  if (!a && !c) { comboUsed = false; comboFired = false; }
  // C 長押し / シリアル "setup": 設定ポータル (転送中は受け付けない)
  if (portal && g_state != S_RUN && !g_sending) {
    onsOff();
    webSocket.close();
    runPortal("requested");
  }
}

void loop() {
  M5.update();
  webSocket.loop();
  wsHeartbeat();                                   // 生存確認 (送信相手は 10 分待つ。rev.42)
  processEvents();                                 // 割り込みからのイベント (ACK・案内)
  watchMotion();                                   // 止まった / 空通しの復路の終わり
  voiceUpdate();
  static uint32_t lastLive = 0;
  if (g_moving && millis() - lastLive > 200) { lastLive = millis(); g_dirty = true; }   // 針カウントを更新
  if (g_dirty) { drawStatus(); g_dirty = false; }
  sendStatus(false);
  handleButtons();
  if (g_kick && millis() - g_kickMs >= KICK_WAIT_MS) {     // 切断要求のあと閉じない相手はこちらから切る
    g_kick = false;
    webSocket.disconnect();
  }
  delay(1);                                        // WS ループへ時間を渡す
}
