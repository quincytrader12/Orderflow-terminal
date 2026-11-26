// The bot builder: a crypto bot as a chain of blocks, each holding one or more
// picks from a list written in plain English —
//
//   style → strategies → market models → forecasts & AI decision maker
//         → risk management → rules → backtest → deploy
//
// The style (scalping … a year's hold) sets the candles, the look-backs, the
// holding time and the stop width, so every other block works at that pace.
// A block can hold several picks: two strategies (joined: all must agree, a
// majority, or any one), several market filters, several second opinions, the
// forest and the neural network paired, two sizing rules (the smaller wins).
//
// checkFlow reads the picks the moment they are made and says which ones
// clash (they fight each other), overlap (they say the same thing) or pair
// well (they add to each other) — from what each one does. The backtest then
// measures it: each strategy alone and together, how often they agree, what
// each filter adds, and each decision maker on its own.
//
// buildSpec turns a chain into the Strategy Lab's StrategySpec; the Lab tests
// it on years of history (training on the first 70 %, judging on the last
// 30 % it never saw) and only then can it be deployed.
import { regimeSide, type Combine, type RuleRef, type Sizing, type StrategySpec } from './backtest';
import { EXIT_DEFAULT, FILTER_MAP, SIGNAL_MAP, type Family, type Params } from './library';

export type StyleId = 'scalp1' | 'scalp15' | 'intraday15' | 'scalp' | 'intraday' | 'swing' | 'week' | 'position' | 'hold';

export interface Style {
  id: StyleId;
  name: string;
  /** what it means, in one line */
  plain: string;
  timeframe: '1m' | '15m' | '1h' | '4h' | '1d';
  tfH: number;
  /** the style whose picks suit this one too (the 15-minute styles take the hourly ones' advice) */
  like?: StyleId;
  /** years of history to test on */
  years: number;
  /** the typical look-back of its signals, in hours */
  L: number;
  /** how long a trade is held at most, in hours */
  holdH: number;
  /** the stop distance in ATR for a "normal" stop */
  stop: number;
  /** a note, when the style has a caveat */
  note?: string;
}

export const STYLES: Style[] = [
  { id: 'scalp1', name: 'Scalping — 1-minute candles, minutes', plain: 'The fastest pace: trades over within minutes on 1-minute candles, built on the same rules as the other paces.', timeframe: '1m', tfH: 1 / 60, years: 30 / 365, L: 15, holdH: 0.5, stop: 1.5, like: 'scalp15', note: 'Thirty days of 1-minute candles (43,000). Costs decide everything at this speed: every test charges double slippage on top of the fees, and the signal is only acted on at the next candle — the edge has to survive that.' },
  { id: 'scalp15', name: 'Scalping — 15-minute candles, minutes to hours', plain: 'The fastest the Lab trades: many trades a day on 15-minute candles, each over within a couple of hours.', timeframe: '15m', tfH: 0.25, years: 0.5, L: 3, holdH: 2, stop: 1.5, like: 'scalp', note: 'Six months of history (17,000 candles). At this speed fees and slippage take a large share of every trade — the test counts them, and many ideas that look good on a chart do not survive them.' },
  { id: 'intraday15', name: 'Intraday — 15-minute candles, closed within a day', plain: 'Several trades a day on 15-minute candles, none held overnight.', timeframe: '15m', tfH: 0.25, years: 1, L: 8, holdH: 12, stop: 2, like: 'intraday', note: 'A year of history (35,000 candles): the first test downloads it, later ones reuse it.' },
  { id: 'scalp', name: 'Scalping — quick trades, hours', plain: 'Many quick trades, in and out within a few hours, small moves.', timeframe: '1h', tfH: 1, years: 1, L: 12, holdH: 6, stop: 1.5, note: 'On 1-hour candles: scalping over hours. For faster trading choose a 15-minute style.' },
  { id: 'intraday', name: 'Intraday — closed within a day', plain: 'Trades that open and close the same day.', timeframe: '1h', tfH: 1, years: 2, L: 24, holdH: 24, stop: 2 },
  { id: 'swing', name: 'Swing — a few days', plain: 'Catch a move that lasts two to five days.', timeframe: '4h', tfH: 4, years: 3, L: 72, holdH: 96, stop: 2.5 },
  { id: 'week', name: 'One-week trades', plain: 'Hold for about a week, riding the week’s direction.', timeframe: '4h', tfH: 4, years: 3, L: 168, holdH: 168, stop: 3 },
  { id: 'position', name: 'Position — weeks to months', plain: 'Ride a big trend for weeks or months; few trades.', timeframe: '1d', tfH: 24, years: 5, L: 720, holdH: 24 * 60, stop: 3 },
  { id: 'hold', name: 'Long-term hold — up to a year', plain: 'Buy into strength and hold through the year, stepping aside in bear markets.', timeframe: '1d', tfH: 24, years: 6, L: 2160, holdH: 24 * 365, stop: 4 },
];
export const STYLE_MAP = Object.fromEntries(STYLES.map((s) => [s.id, s])) as Record<StyleId, Style>;
/** a style's history in words: "6 months", "1 year", "3 years" */
export const historyWords = (s: Style) => (s.years < 1 ? `${Math.round(s.years * 12)} months` : `${s.years} year${s.years > 1 ? 's' : ''}`);

export interface Option {
  id: string;
  /** the group it is listed under */
  group: string;
  name: string;
  plain: string;
  /** styles it suits best (listed first, marked ✓) */
  suits?: StyleId[];
}

const fast = (s: Style) => s.L <= 24;
/** a floor on a look-back (written for hourly candles), a quarter as long on 15-minute ones; on 1-minute candles the same count of candles (20 → 20 minutes) */
const fl = (s: Style, hours: number) => (s.tfH < 0.1 ? hours : s.tfH < 1 ? hours / 4 : hours);
const slow = (s: Style) => s.L >= 720;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ---------- 1. the strategies (entry rules) ----------

export interface StrategyOption extends Option {
  signal: string;
  params: (s: Style) => Params;
  /** state: it always has a view (long or short); event: it fires now and then */
  nature: 'state' | 'event';
  /** the rule's own holding time in hours, when it has one (a two-hour window, a day): the style's hold never stretches it */
  holdH?: number;
  /** it only ever buys */
  longOnly?: boolean;
  /** it reads bitcoin beside the coin: BTC joins the coins, and it never trades BTC itself */
  needsBtc?: boolean;
  /** part trend, part dip-buying: the family rules of thumb do not apply to it */
  mixed?: boolean;
}

export const STRATEGIES: StrategyOption[] = [
  // trend following
  { id: 'tsmom', group: 'Trend following', name: 'Ride the trend (momentum)', plain: 'Buys when the price has gone up over the look-back period, sells short when it has gone down. The most studied edge in markets.', suits: ['swing', 'week', 'position', 'hold'], signal: 'tsmom', nature: 'state', params: (s) => ({ lookback: s.L }) },
  { id: 'mac', group: 'Trend following', name: 'Moving-average crossover', plain: 'Buys when a fast average of price crosses above a slow one, sells when it crosses below. Classic and simple.', suits: ['swing', 'week', 'position', 'hold'], signal: 'mac', nature: 'state', params: (s) => ({ fast: Math.max(fl(s, 12), s.L / 2), slow: Math.max(fl(s, 48), s.L * 3) }) },
  { id: 'tma', group: 'Trend following', name: 'Three averages lined up', plain: 'Trades only when a fast, a middle and a slow average are stacked in order — a confirmed trend, fewer false starts.', suits: ['intraday', 'swing', 'week'], signal: 'tma', nature: 'state', params: (s) => ({ set: fast(s) ? 0 : slow(s) ? 2 : 1 }) },
  { id: 'maratio', group: 'Trend following', name: 'Price far from its average', plain: 'Buys when the price is clearly above its average (a strong trend), sells when clearly below.', suits: ['week', 'position', 'hold'], signal: 'maratio', nature: 'state', params: (s) => ({ lookback: s.L * 2, band: 0.02 }) },
  { id: 'kalman', group: 'Trend following', name: 'Smart trend line (Kalman filter)', plain: 'A noise-filtering trend line that also says how sure it is; trades only when the trend is clear.', suits: ['intraday', 'swing', 'week', 'position'], signal: 'kalman', nature: 'state', params: (s) => ({ smooth: fast(s) ? 2 : slow(s) ? 0 : 1, k: 2 }) },
  { id: 'macd', group: 'Trend following', name: 'MACD trend', plain: 'The popular MACD indicator: long while it is above its signal line, short while below.', suits: ['intraday', 'swing', 'week'], signal: 'macd', nature: 'state', params: (s) => ({ scale: fast(s) ? 1 : slow(s) ? 24 : 4 }) },
  { id: 'vsmom', group: 'Trend following', name: 'Momentum that adjusts for volatility', plain: 'Momentum, but a move only counts if it is big for how jumpy the coin is right now (GARCH volatility).', suits: ['intraday', 'swing', 'week'], signal: 'vsmom', nature: 'state', params: (s) => ({ lookback: s.L, k: 1 }) },
  { id: 'vwmom', group: 'Trend following', name: 'Momentum weighted by volume', plain: 'Momentum where each candle counts by how much was traded: moves made on heavy volume decide the direction. In crypto studies this beat plain momentum.', suits: ['swing', 'week', 'position'], signal: 'vwmom', nature: 'state', params: (s) => ({ lookback: s.L }) },
  { id: 'ctrend', group: 'Trend following', name: 'Trend composite (17 indicators vote)', plain: 'RSI, stochastic, CCI, seven moving averages, MACD, volume trends, money flow and Bollinger bands each cast a vote; trades when most agree. Based on the crypto trend factor published in 2025.', suits: ['intraday', 'swing', 'week', 'position'], signal: 'ctrend', nature: 'state', params: (s) => ({ unit: fast(s) ? 4 : 24, k: 0.3 }) },
  { id: 'atrtrend', group: 'Trend following', name: 'ATR trend line (Supertrend)', plain: 'A line trails the price a few “average true ranges” away and only ever tightens. Long while price holds above it, short while below; the side flips when a close crosses the line. It sits through ordinary pullbacks and leaves on an unusual reversal.', suits: ['intraday', 'swing', 'week', 'position'], signal: 'atrtrend', nature: 'state', params: (s) => ({ n: clamp(Math.round(s.L / 3), fl(s, 10), 40), k: 3 }) },
  // breakouts
  { id: 'donchian', group: 'Breakouts', name: 'Break of the recent high or low', plain: 'Buys when price closes above its highest high of the period, sells below the lowest low. Catches new trends early.', suits: ['intraday', 'swing', 'week', 'position'], signal: 'donchian', nature: 'event', params: (s) => ({ n: Math.max(fl(s, 20), s.L) }) },
  { id: 'bbreak', group: 'Breakouts', name: 'Bollinger band breakout', plain: 'Trades a close outside the Bollinger bands — a move bigger than normal for the coin.', suits: ['scalp', 'intraday', 'swing'], signal: 'bbreak', nature: 'event', params: (s) => ({ lookback: Math.max(fl(s, 20), s.L), k: 2 }) },
  { id: 'pivot', group: 'Breakouts', name: 'Support and resistance (pivots)', plain: 'Buys a close above yesterday’s resistance, sells a close below support. A day trader’s classic.', suits: ['scalp', 'intraday'], signal: 'pivot', nature: 'event', params: () => ({ level: 1 }) },
  { id: 'volbrk', group: 'Breakouts', name: 'Big move on heavy volume', plain: 'Follows a sharp move only when volume is unusually heavy — a sign big players are behind it.', suits: ['scalp', 'intraday'], signal: 'volbrk', nature: 'event', params: (s) => ({ n: clamp(Math.round(s.L / 6), 1, 24), k: 2 }) },
  { id: 'maxmin', group: 'Breakouts', name: 'New 10-day high or low (buy both)', plain: 'Buys when price closes at a new 10-day high (the trend continues) and when it closes at a new 10-day low (the bounce after panic), and holds a day. A documented bitcoin pattern; it never shorts.', suits: ['swing', 'week', 'position'], signal: 'maxmin', nature: 'event', holdH: 24, longOnly: true, mixed: true, params: () => ({ n: 240, mode: 0 }) },
  { id: 'jump', group: 'Breakouts', name: 'Follow a big day', plain: 'After a day with an unusually big move (2.5 times its normal size), trades in the same direction for a day. In crypto, extreme days were followed more often than faded — but the published edge was thin.', suits: ['intraday', 'swing'], signal: 'jump', nature: 'event', holdH: 24, params: () => ({ k: 2.5 }) },
  { id: 'squeeze', group: 'Breakouts', name: 'Volatility squeeze breakout', plain: 'Quiet markets do not stay quiet. When the bands around price are among the narrowest they have been in a long while, it waits for the first close outside them and goes with it — the start of the next big move — until price falls back through its average.', suits: ['scalp', 'intraday', 'swing', 'week'], signal: 'squeeze', nature: 'event', params: (s) => ({ lookback: clamp(s.L, fl(s, 20), 100), squeeze: clamp(s.L * 5, fl(s, 120), 480), k: 2 }) },
  // mean reversion
  { id: 'zrev', group: 'Buy the dip / sell the rip', name: 'Stretched from the average (z-score)', plain: 'Buys when price has fallen unusually far below its average, sells when it has risen unusually far — betting it snaps back.', suits: ['scalp', 'intraday', 'swing'], signal: 'zrev', nature: 'event', params: (s) => ({ lookback: Math.max(fl(s, 24), s.L), k: 2 }) },
  { id: 'rsi2', group: 'Buy the dip / sell the rip', name: 'RSI oversold / overbought', plain: 'Buys when the RSI says oversold, sells when overbought. Short, sharp bounces.', suits: ['scalp', 'intraday', 'swing'], signal: 'rsi2', nature: 'event', params: (s) => (fast(s) ? { n: 2, band: 10 } : { n: 14, band: 30 }) },
  { id: 'ou', group: 'Buy the dip / sell the rip', name: 'Snap-back to fair value (Ornstein–Uhlenbeck)', plain: 'Fits a “rubber band” model to the price and trades when it is stretched far — only when it has been snapping back fast.', suits: ['intraday', 'swing'], signal: 'ou', nature: 'event', params: (s) => ({ window: clamp(s.L * 2, fl(s, 72), 336), k: 2 }) },
  { id: 'wrev', group: 'Buy the dip / sell the rip', name: 'Fade a big weekly move', plain: 'After a week with a very big rise or fall, bets on part of it coming back.', suits: ['swing', 'week'], signal: 'wrev', nature: 'event', params: () => ({ band: 0.1 }) },
  // intraday
  { id: 'vwap', group: 'Intraday (the day’s own structure)', name: 'VWAP trend', plain: 'Long while price is above the day’s volume-weighted average price (what the average buyer paid today), short while below. A day trader’s staple, published as a tested system in 2023.', suits: ['scalp', 'intraday'], signal: 'vwap', nature: 'state', holdH: 24, params: () => ({ anchor: 0, band: 0.5 }) },
  { id: 'orb', group: 'Intraday (the day’s own structure)', name: 'Opening range breakout', plain: 'The first two hours of the day set a range; trades the first close beyond it, in that direction, for the rest of the day. One trade a day.', suits: ['scalp', 'intraday'], signal: 'orb', nature: 'event', holdH: 22, params: () => ({ anchor: 0, range: 2 }) },
  { id: 'noise', group: 'Intraday (the day’s own structure)', name: 'Intraday momentum beyond the noise', plain: 'Trades when the day’s move is bigger than is normal for that time of day (against the last two weeks) — a move the day has not absorbed tends to run. A 2024 study’s best intraday rule.', suits: ['scalp', 'intraday'], signal: 'noise', nature: 'state', holdH: 24, params: () => ({ anchor: 0, k: 1 }) },
  // ICT and Candle Range Theory
  { id: 'crt4', group: 'ICT & Candle Range Theory', name: 'CRT: sweep of the last 4-hour candle', plain: 'Candle Range Theory: when price runs past the previous 4-hour candle’s high (or low) and closes back inside its range, it trades back toward the other side. The stops beyond were taken and nobody followed.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'crt', nature: 'event', holdH: 12, params: () => ({ htf: 4, depth: 0 }) },
  { id: 'crtd', group: 'ICT & Candle Range Theory', name: 'CRT: sweep of yesterday’s candle', plain: 'Candle Range Theory on the daily candle: a run past yesterday’s high (or low) that closes back inside — the stop run before the real move — trades back across yesterday’s range.', suits: ['scalp', 'intraday', 'intraday15', 'swing'], signal: 'crt', nature: 'event', holdH: 24, params: () => ({ htf: 24, depth: 0 }) },
  { id: 'monday', group: 'ICT & Candle Range Theory', name: 'The Monday range (false break)', plain: 'Monday’s high and low frame the week. From Tuesday, a run past one of them that closes back inside is a false move: trade back across the range.', suits: ['intraday', 'swing', 'week'], signal: 'monday', nature: 'event', holdH: 72, params: () => ({ mode: 0 }) },
  { id: 'monday-break', group: 'ICT & Candle Range Theory', name: 'The Monday range (true break)', plain: 'Monday’s high and low frame the week. From Tuesday, the first close beyond the range is the week’s direction: trade it.', suits: ['intraday', 'swing', 'week'], signal: 'monday', nature: 'event', holdH: 72, params: () => ({ mode: 1 }) },
  { id: 'sweep', group: 'ICT & Candle Range Theory', name: 'Liquidity sweep (turtle soup)', plain: 'A candle takes out the highest high (or lowest low) of recent days and closes back inside: the stops were run and nobody followed — trade the reversal.', suits: ['scalp', 'intraday', 'scalp15', 'intraday15', 'swing'], signal: 'sweep', nature: 'event', holdH: 24, params: (s) => ({ lookback: s.L <= 12 ? 24 : s.L <= 24 ? 72 : 168 }) },
  { id: 'fvg', group: 'ICT & Candle Range Theory', name: 'Fair value gap retrace', plain: 'A displacement candle leaves a gap (a fair value gap); when price comes back into it, trade in the displacement’s direction.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'fvg', nature: 'event', holdH: 24, params: (s) => ({ k: 0.3, age: s.L <= 24 ? 12 : 48 }) },
  { id: 'mss', group: 'ICT & Candle Range Theory', name: 'Market structure shift', plain: 'First a sweep of the recent low (stops taken), then a close above the swing high before it: structure has turned — buy. And the mirror for shorts.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'mss', nature: 'event', holdH: 36, params: (s) => ({ lookback: s.L <= 24 ? 24 : 72, window: s.tfH < 1 ? 6 : 12 }) },
  { id: 'silver', group: 'ICT & Candle Range Theory', name: 'Silver Bullet (10:00 New York)', plain: 'ICT’s Silver Bullet: in the 10:00–11:00 New York window, the first fair value gap to form is traded in its direction, once a day. The edge finder also tries the 03:00 and 14:00 windows.', suits: ['scalp15', 'intraday15', 'scalp'], signal: 'silver', nature: 'event', holdH: 8, params: () => ({ win: 1, k: 0.1 }) },
  { id: 'judas', group: 'ICT & Candle Range Theory', name: 'London Judas swing (power of three)', plain: 'The Asian hours build a range; London fakes a move beyond one side and closes back inside; the day’s real move goes the other way — trade it into New York.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'judas', nature: 'event', holdH: 14, params: () => ({ depth: 0 }) },
  { id: 'crtw', group: 'ICT & Candle Range Theory', name: 'CRT: sweep of last week’s candle', plain: 'Candle Range Theory on the weekly candle: a run past last week’s high (or low) that closes back inside trades back across last week’s range.', suits: ['intraday', 'swing', 'week'], signal: 'crt', nature: 'event', holdH: 72, params: () => ({ htf: 168, depth: 0 }) },
  { id: 'crt4ny', group: 'ICT & Candle Range Theory', name: 'CRT: 4-hour candles on the New York clock', plain: 'Candle Range Theory on the 4-hour candles ICT reads — opening 01:00, 05:00 and 09:00 New York time: a sweep of the last one that closes back inside trades to its other side.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'crt', nature: 'event', holdH: 12, params: () => ({ htf: 4, depth: 0, ny: 1 }) },
  { id: 'crtdny', group: 'ICT & Candle Range Theory', name: 'CRT: the New York day’s candle', plain: 'Candle Range Theory with the day starting at midnight New York, as ICT draws it: a run past yesterday’s high or low that closes back inside.', suits: ['scalp', 'intraday', 'intraday15', 'swing'], signal: 'crt', nature: 'event', holdH: 24, params: () => ({ htf: 24, depth: 0, ny: 1 }) },
  { id: 'crt-break', group: 'ICT & Candle Range Theory', name: 'CRT: expansion beyond the last candle', plain: 'The other Candle Range Theory style: a close beyond the last 4-hour candle’s high or low is the expansion — go with it.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'crt', nature: 'event', holdH: 12, params: () => ({ htf: 4, depth: 0.25, mode: 1 }) },
  { id: 'crtd-break', group: 'ICT & Candle Range Theory', name: 'CRT: expansion beyond yesterday', plain: 'A close beyond yesterday’s high or low, by a quarter of a normal candle or more, is the day’s expansion — go with it.', suits: ['scalp', 'intraday', 'intraday15', 'swing'], signal: 'crt', nature: 'event', holdH: 24, params: () => ({ htf: 24, depth: 0.25, mode: 1 }) },
  { id: 'london-break', group: 'ICT & Candle Range Theory', name: 'London breakout of the Asian range', plain: 'The Asian hours (00–06 UTC) set a range; London’s first close beyond it is the day’s direction — trade it.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'judas', nature: 'event', holdH: 14, params: () => ({ depth: 0.2, mode: 1 }) },
  { id: 'nyrev', group: 'ICT & Candle Range Theory', name: 'New York reversal of London', plain: 'London (02:00–07:00 New York) sets the day’s range. When New York runs past one side of it and closes back inside, the London high or low was the liquidity — trade the turn.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'nyrev', nature: 'event', holdH: 10, params: () => ({ mode: 0 }) },
  { id: 'ny-break', group: 'ICT & Candle Range Theory', name: 'New York breakout of London', plain: 'London (02:00–07:00 New York) sets the range; the first New York close beyond it (08:00–11:00) is followed.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'nyrev', nature: 'event', holdH: 10, params: () => ({ mode: 1 }) },
  { id: 'ob', group: 'ICT & Candle Range Theory', name: 'Order block retest', plain: 'A strong candle that breaks structure leaves an order block — the last opposite candle before it. The first return to that candle is traded in the strong candle’s direction.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'ob', nature: 'event', holdH: 24, params: (s) => ({ k: fast(s) ? 1 : 1.5, age: fast(s) ? 24 : 72 }) },
  { id: 'breaker', group: 'ICT & Candle Range Theory', name: 'Breaker block', plain: 'An order block that fails — price closes through it — traps those who traded it. On the first return to it, trade against it.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'breaker', nature: 'event', holdH: 24, params: (s) => ({ k: 1, age: fast(s) ? 24 : 72 }) },
  { id: 'ifvg', group: 'ICT & Candle Range Theory', name: 'Inversion fair value gap', plain: 'A fair value gap that price closes straight through has flipped sides: the first retest of it is traded the other way.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'ifvg', nature: 'event', holdH: 24, params: (s) => ({ k: 0.3, age: fast(s) ? 12 : 48 }) },
  { id: 'ote', group: 'ICT & Candle Range Theory', name: 'Optimal trade entry (62–79 %)', plain: 'After a strong push to a new high, buys the pullback into the 62–79 % retracement of the leg — ICT’s optimal trade entry — for the move to resume (the mirror after a new low).', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'ote', nature: 'event', holdH: 36, params: (s) => ({ lookback: fast(s) ? 24 : 72, k: fast(s) ? 2 : 4 }) },
  { id: 'eqhl', group: 'ICT & Candle Range Theory', name: 'Equal highs and lows swept', plain: 'Two swing highs at nearly the same price are a pool of stops. A run above both that closes back below took the stops and found nobody: trade the reversal (and the mirror at equal lows).', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'eqhl', nature: 'event', holdH: 24, params: (s) => ({ lookback: fast(s) ? 24 : 72, tol: 0.25 }) },
  { id: 'smt', group: 'ICT & Candle Range Theory', name: 'SMT divergence against bitcoin', plain: 'When the coin makes a new low and bitcoin does not, the low was a stop run the market did not confirm — buy (the mirror at highs). ICT’s smart money technique.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'smt', nature: 'event', holdH: 24, needsBtc: true, params: (s) => ({ lookback: fast(s) ? 24 : 72 }) },
  { id: 'spring', group: 'Wyckoff & volume', name: 'Wyckoff spring and upthrust', plain: 'After a tight range, a dip below its low that closes back inside is the last shake-out before the move up (a spring); the mirror at the top is an upthrust.', suits: ['intraday15', 'scalp', 'intraday', 'swing'], signal: 'spring', nature: 'event', holdH: 36, params: (s) => ({ lookback: fast(s) ? 24 : 72, w: fast(s) ? 4 : 8 }) },
  // Smart Money Concepts, Wyckoff and volume
  { id: 'bos', group: 'Smart Money Concepts', name: 'SMC: break of structure', plain: 'The structure is up (higher highs and higher lows) and a candle closes above the last swing high: the trend carries on — follow it (the mirror in a downtrend).', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'bos', nature: 'event', holdH: 36, params: (s) => ({ k: fast(s) ? 2 : 3 }) },
  { id: 'choch', group: 'Smart Money Concepts', name: 'SMC: change of character', plain: 'The structure was down and a candle closes above the last swing high: the first sign the sellers have lost control — take the new direction (the mirror at the top).', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'choch', nature: 'event', holdH: 36, params: (s) => ({ k: fast(s) ? 2 : 3 }) },
  { id: 'choch5', group: 'Smart Money Concepts', name: 'SMC: change of character (major swings)', plain: 'A change of character on the bigger swings (five candles either side): fewer, more meaningful turns.', suits: ['intraday15', 'scalp', 'intraday', 'swing', 'week'], signal: 'choch', nature: 'event', holdH: 48, params: () => ({ k: 5 }) },
  { id: 'idm', group: 'Smart Money Concepts', name: 'SMC: inducement sweep', plain: 'After a break of structure, the first small swing low is the inducement where early buyers put their stops; buy the candle that takes those stops and closes back above (the mirror in a downtrend).', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'idm', nature: 'event', holdH: 36, params: (s) => ({ k: 2, age: fast(s) ? 24 : 72 }) },
  { id: 'sdzone', group: 'Smart Money Concepts', name: 'SMC: supply and demand zone', plain: 'A base of small candles followed by a strong move is a demand (or supply) zone; the first return to it is traded in the strong move’s direction.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'sdzone', nature: 'event', holdH: 36, params: (s) => ({ k: fast(s) ? 1.5 : 2.5, age: fast(s) ? 48 : 168 }) },
  { id: 'wysos', group: 'Wyckoff & volume', name: 'Wyckoff: sign of strength', plain: 'After a tight trading range, a wide candle on heavy volume closing above it: demand has taken over — buy (the mirror out of distribution: a sign of weakness).', suits: ['intraday15', 'scalp', 'intraday', 'swing', 'week'], signal: 'wysos', nature: 'event', holdH: 48, params: (s) => ({ lookback: fast(s) ? 48 : 120, w: fast(s) ? 5 : 8, mode: 0 }) },
  { id: 'wylps', group: 'Wyckoff & volume', name: 'Wyckoff: last point of support', plain: 'After a sign of strength, the first pullback to the top of the old range that holds and closes back above it: buy (the mirror after a sign of weakness).', suits: ['intraday15', 'scalp', 'intraday', 'swing', 'week'], signal: 'wysos', nature: 'event', holdH: 48, params: (s) => ({ lookback: fast(s) ? 48 : 120, w: fast(s) ? 5 : 8, mode: 1 }) },
  { id: 'climax', group: 'Wyckoff & volume', name: 'Wyckoff: selling or buying climax', plain: 'A very wide candle on extreme volume at a new low (panic absorbed by big buyers), then a close above it within three candles: buy (the mirror at a top).', suits: ['intraday15', 'scalp', 'intraday', 'swing'], signal: 'climax', nature: 'event', holdH: 48, params: (s) => ({ lookback: fast(s) ? 72 : 168, v: 2 }) },
  { id: 'effort', group: 'Wyckoff & volume', name: 'Wyckoff: effort without result', plain: 'Heavy volume that barely moves price at a new low — the selling is being absorbed (stopping volume): buy (the mirror at a high).', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'effort', nature: 'event', holdH: 24, params: (s) => ({ lookback: fast(s) ? 24 : 72, v: 1.5 }) },
  // price action
  { id: 'insidebar', group: 'Price action (candles)', name: 'Inside bar breakout', plain: 'A candle inside the one before it is the market pausing; the first close beyond the bigger candle shows who won — trade it.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'insidebar', nature: 'event', holdH: 12, params: () => ({ n: 1 }) },
  { id: 'insidebar2', group: 'Price action (candles)', name: 'Two inside bars, then the break', plain: 'Two candles inside a bigger one — a tighter coil; the first close beyond the bigger candle is traded.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'insidebar', nature: 'event', holdH: 12, params: () => ({ n: 2 }) },
  { id: 'engulf', group: 'Price action (candles)', name: 'Engulfing candle at an extreme', plain: 'At the lowest point of recent days, a green candle whose body swallows the red one before it: buy (the mirror at a high).', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'engulf', nature: 'event', holdH: 24, params: (s) => ({ lookback: fast(s) ? 24 : 72 }) },
  { id: 'pinbar', group: 'Price action (candles)', name: 'Pin bar (hammer) rejection', plain: 'A candle with a long tail through the recent low and a small body near its top: the low was rejected — buy (the mirror at a high).', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'pinbar', nature: 'event', holdH: 24, params: (s) => ({ r: 2, lookback: fast(s) ? 24 : 72 }) },
  { id: 'nr7', group: 'Price action (candles)', name: 'Narrowest candle of seven (NR7)', plain: 'The quietest candle of the last seven: quiet is followed by movement — trade the first close beyond it.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], signal: 'nr', nature: 'event', holdH: 12, params: () => ({ n: 7 }) },
  { id: 'nr4', group: 'Price action (candles)', name: 'Narrowest candle of four (NR4)', plain: 'The quietest candle of the last four; trade the first close beyond it within three candles.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'nr', nature: 'event', holdH: 12, params: () => ({ n: 4 }) },
  { id: 'round', group: 'Price action (candles)', name: 'Round-number rejection', plain: 'Orders cluster at round prices. A candle that pokes through a round level and closes back on the near side is fading against that wall of orders.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], signal: 'round', nature: 'event', holdH: 24, params: () => ({ m: 5 }) },
  { id: 'fade', group: 'Buy the dip / sell the rip', name: 'Fade a stretched candle', plain: 'After one unusually big candle on heavy volume, bets on part of it coming back in the next few. Real on 15-minute crypto candles but small — fees decide whether anything is left.', suits: ['scalp'], signal: 'fade', nature: 'event', holdH: 1, params: () => ({ k: 2, vol: 1 }) },
  // timing
  { id: 'itsm', group: 'Timing and seasons', name: 'End-of-day momentum', plain: 'Late in the US session, trades the direction the day has taken so far into the close.', suits: ['intraday'], signal: 'itsm', nature: 'event', holdH: 3, params: () => ({ hour: 21 }) },
  { id: 'night', group: 'Timing and seasons', name: 'Late-evening hours (21:00–23:00 UTC)', plain: 'Buys at 21:00 UTC and sells at 23:00 UTC every day: the two hours where bitcoin’s gains were concentrated in 2015–2021. The pattern weakened after — test before trusting it.', suits: ['scalp', 'intraday'], signal: 'night', nature: 'event', holdH: 2, longOnly: true, params: () => ({ hour: 21 }) },
  { id: 'dow', group: 'Timing and seasons', name: 'Monday effect', plain: 'Buys at the start of Monday and holds for the day (a documented weekday pattern in bitcoin).', suits: ['intraday'], signal: 'dow', nature: 'event', holdH: 24, longOnly: true, params: () => ({ day: 1 }) },
  // against bitcoin
  { id: 'pairs', group: 'Against bitcoin (relative value)', name: 'Pairs trade: the coin against bitcoin', plain: 'Coins move with bitcoin. When a coin gets unusually cheap against bitcoin it buys the coin, when unusually rich it sells — betting the gap closes. Add the bitcoin hedge (Risk) to make it a true market-neutral pairs trade.', suits: ['scalp', 'intraday', 'swing'], signal: 'pairs', nature: 'event', needsBtc: true, params: (s) => ({ window: clamp(s.L * 7, fl(s, 168), 720), k: 2 }) },
  { id: 'btclead', group: 'Against bitcoin (relative value)', name: 'Bitcoin leads, the coin catches up', plain: 'When bitcoin has moved and a coin has not yet followed by its usual amount, trades the coin in bitcoin’s direction. News reaches bitcoin first; the published effect is fastest over minutes.', suits: ['scalp', 'intraday'], signal: 'btclead', nature: 'event', needsBtc: true, params: (s) => ({ n: s.tfH < 1 ? 0.25 : clamp(Math.round(s.L / 12), 1, 24), k: 1 }) },
  { id: 'rsbtc', group: 'Against bitcoin (relative value)', name: 'Relative strength: coins beating bitcoin', plain: 'Coins that have been beating bitcoin tend to keep beating it for weeks, and laggards keep lagging. It buys a coin that has outrun bitcoin by more than its usual wobble and sells one that has fallen behind. Add the bitcoin hedge (Risk) to trade the difference alone.', suits: ['swing', 'week', 'position'], signal: 'rsbtc', nature: 'state', needsBtc: true, params: (s) => ({ lookback: clamp(s.L * 3, fl(s, 168), 720), k: 0.5 }) },
  // carry
  { id: 'carry', group: 'Funding (carry)', name: 'Get paid funding', plain: 'Takes the side the crowd is paying for: short when longs pay heavy funding, long when shorts do.', suits: ['swing', 'week'], signal: 'carry', nature: 'state', params: () => ({ lookback: 72, band: 0.25 }) },
  // machine learning
  { id: 'nn', group: 'AI (machine learning)', name: 'AI: neural network', plain: 'A neural network (two layers of artificial neurons) learns from 30+ market readings which way price goes next; trades when it is confident. It stops learning when it stops improving on its latest data, so it does not memorise.', suits: ['scalp', 'intraday', 'swing'], signal: 'nn', nature: 'state', params: (s) => ({ horizon: fast(s) ? 4 : 24, edge: 0.05 }) },
  { id: 'rf', group: 'AI (machine learning)', name: 'AI: random forest', plain: 'A machine-learning model (a forest of decision trees) learns from 30+ market readings which way price goes next; trades when it is confident.', suits: ['scalp', 'intraday', 'swing'], signal: 'rf', nature: 'state', params: (s) => ({ horizon: fast(s) ? 4 : 24, edge: 0.05 }) },
  { id: 'ols', group: 'AI (machine learning)', name: 'AI: linear forecast', plain: 'A regression combines 30+ market readings into one forecast of the next move; trades the strong forecasts.', suits: ['scalp', 'intraday', 'swing'], signal: 'ols', nature: 'state', params: (s) => ({ horizon: fast(s) ? 4 : 24, q: 1 }) },
  { id: 'candle', group: 'AI (machine learning)', name: 'AI: next-candle forecast', plain: 'Reads the shape of recent candles (bodies, wicks, patterns) and forecasts the next candle; trades the clear calls.', suits: ['scalp', 'intraday'], signal: 'candle', nature: 'event', params: () => ({ edge: 0.05 }) },
];

export const COMBINES: { id: Combine; name: string; plain: string }[] = [
  { id: 'all', name: 'All must agree', plain: 'Enter only when every strategy points the same way at the same candle. Fewer, better-confirmed trades.' },
  { id: 'majority', name: 'Majority vote', plain: 'Enter when more than half of the strategies point the same way and none points the other way.' },
  { id: 'any', name: 'Any one (unless another disagrees)', plain: 'Enter when any strategy fires, as long as none of the others points the other way. More trades.' },  { id: 'switch', name: 'Regime switch (trend rules in trends, dip rules in ranges)', plain: 'Reads the market’s regime every candle (ADX): while it trends, only the trend and breakout strategies trade; while it ranges, only the dip-buying ones. Each strategy works in the market it was made for — the classic way to pair a trend rule with a dip rule.' },
  { id: 'then', name: 'Setup, then trigger', plain: 'The first strategy sets the direction; the trade is taken when the others confirm it within the next few candles. A breakout and the volume that confirms it need not land on the same candle.' },
];

// ---------- 2. the market models (filters: when the strategies are allowed to trade) ----------

export type Lean = 'trend' | 'range' | 'calm' | 'storm' | 'session' | 'volume' | 'crowd' | 'market' | 'weekdays' | 'weekends';
export interface ModelOption extends Option {
  filter: RuleRef | ((s: Style) => RuleRef);
  /** what market it asks for */
  lean: Lean;
}

export const MODELS: ModelOption[] = [
  { id: 'trend', group: 'Trend', name: 'Only with the big trend', plain: 'Longs only above the long-term average, shorts only below — trade with the tide, not against it.', suits: ['intraday', 'swing', 'week', 'position', 'hold'], lean: 'trend', filter: (s) => ({ id: 'trend', p: { lookback: Math.max(200, s.L * 8) } }) },
  { id: 'btc-trend', group: 'Trend', name: 'Only with bitcoin’s trend (the market)', plain: 'Bitcoin is the crypto market: longs only while bitcoin is above its long-term average, shorts only while below. Keeps a coin’s trades on the side of the whole market.', suits: ['intraday', 'swing', 'week', 'position'], lean: 'market', filter: (s) => ({ id: 'btctrend', p: { lookback: s.L >= 720 ? 4800 : 1200 } }) },
  { id: 'adx-trend', group: 'Trend', name: 'Only when the market is trending (ADX)', plain: 'The ADX indicator measures trend strength; trade only when it says the market is trending.', suits: ['intraday', 'swing', 'week'], lean: 'trend', filter: { id: 'adx', p: { mode: 0, level: 25 } } },
  { id: 'adx-range', group: 'Trend', name: 'Only when the market is ranging (ADX)', plain: 'Trade only when ADX says there is no strong trend — the place for buy-the-dip strategies.', suits: ['scalp', 'intraday'], lean: 'range', filter: { id: 'adx', p: { mode: 1, level: 20 } } },
  { id: 'vr-trend', group: 'Statistical regime', name: 'Only when moves keep going (variance ratio)', plain: 'A statistical test (Lo & MacKinlay) of whether moves have been continuing; trade trend strategies only then.', suits: ['swing', 'week', 'position'], lean: 'trend', filter: { id: 'vratio', p: { mode: 0, window: 720 } } },
  { id: 'vr-revert', group: 'Statistical regime', name: 'Only when moves snap back (variance ratio)', plain: 'The same test, the other way: moves have been reversing — the place for dip-buying.', suits: ['scalp', 'intraday', 'swing'], lean: 'range', filter: { id: 'vratio', p: { mode: 1, window: 720 } } },
  { id: 'hurst-trend', group: 'Statistical regime', name: 'Only when prices have memory (Hurst)', plain: 'The Hurst exponent above 0.55: moves have tended to continue lately — trend strategies’ ground.', suits: ['swing', 'week', 'position'], lean: 'trend', filter: { id: 'hurst', p: { mode: 0 } } },
  { id: 'hurst-revert', group: 'Statistical regime', name: 'Only when prices reverse (Hurst)', plain: 'The Hurst exponent below 0.45: moves have tended to reverse lately — dip-buying’s ground.', suits: ['scalp', 'intraday', 'swing'], lean: 'range', filter: { id: 'hurst', p: { mode: 1 } } },
  { id: 'hmm-calm', group: 'Statistical regime', name: 'Only in calm markets (hidden-Markov)', plain: 'A model that reads whether the market is in its calm or its stormy state; trade only when calm.', lean: 'calm', filter: { id: 'hmm', p: { mode: 0 } } },
  { id: 'hmm-storm', group: 'Statistical regime', name: 'Only in stormy markets (hidden-Markov)', plain: 'The same model; trade only in the stormy state (breakouts often need it).', lean: 'storm', filter: { id: 'hmm', p: { mode: 1 } } },
  { id: 'garch-calm', group: 'Volatility', name: 'Only when volatility is below normal (GARCH)', plain: 'GARCH forecasts how jumpy the coin will be; trade only when it expects less than its normal.', lean: 'calm', filter: { id: 'garch', p: { mode: 0, ratio: 1 } } },
  { id: 'garch-storm', group: 'Volatility', name: 'Only when volatility is above normal (GARCH)', plain: 'Trade only when GARCH expects more movement than normal — when breakouts have fuel.', lean: 'storm', filter: { id: 'garch', p: { mode: 1, ratio: 1 } } },
  { id: 'vol-calm', group: 'Volatility', name: 'Only on quieter days', plain: 'Skips the busiest days of the month (measured by realised volatility).', lean: 'calm', filter: { id: 'volreg', p: { mode: 0, pct: 0.8 } } },
  { id: 'vol-busy', group: 'Volatility', name: 'Only on busier days', plain: 'Trades only on the busier days of the month — when there is movement to catch.', lean: 'storm', filter: { id: 'volreg', p: { mode: 1, pct: 0.8 } } },
  { id: 'volume', group: 'Activity', name: 'Only on above-normal volume', plain: 'Trades only when volume is above its usual level — more participants, more follow-through.', suits: ['scalp', 'intraday'], lean: 'volume', filter: { id: 'volume', p: { k: 0.5 } } },
  { id: 'us', group: 'Activity', name: 'Only in US trading hours', plain: 'Trades only from 13:00 to 21:00 UTC, when the most money is moving.', suits: ['scalp', 'intraday'], lean: 'session', filter: { id: 'session', p: { s: 0 } } },
  { id: 'eu', group: 'Activity', name: 'Only in European trading hours', plain: 'Trades only from 07:00 to 16:00 UTC.', suits: ['scalp', 'intraday'], lean: 'session', filter: { id: 'session', p: { s: 1 } } },
  { id: 'weekdays', group: 'Activity', name: 'Only on weekdays', plain: 'Trades only Monday to Friday (UTC), when volume is full and moves follow through.', lean: 'weekdays', filter: { id: 'weekday', p: { mode: 0 } } },
  { id: 'weekends', group: 'Activity', name: 'Only at weekends', plain: 'Trades only Saturday and Sunday (UTC): thinner, quieter markets where moves fade more often — dip-buying’s ground.', suits: ['scalp', 'intraday'], lean: 'weekends', filter: { id: 'weekday', p: { mode: 1 } } },
  { id: 'kz', group: 'ICT & Candle Range Theory', name: 'Only in the ICT kill zones', plain: 'Trades only in the hours ICT calls kill zones — London 02:00–05:00, New York 07:00–10:00 and 13:30–16:00 (New York time) — when the sessions open and price moves with purpose.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], lean: 'session', filter: { id: 'killzone', p: { z: 3 } } },
  { id: 'kz-ny', group: 'ICT & Candle Range Theory', name: 'Only in the New York kill zone', plain: 'Trades only from 07:00 to 10:00 New York time, the busiest window of the crypto day.', suits: ['scalp15', 'intraday15', 'scalp'], lean: 'session', filter: { id: 'killzone', p: { z: 1 } } },
  { id: 'pd', group: 'ICT & Candle Range Theory', name: 'Buy at a discount, sell at a premium', plain: 'Splits the recent range at its middle: longs only in the lower half (discount), shorts only in the upper half (premium). Never chases.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], lean: 'range', filter: (s) => ({ id: 'pd', p: { lookback: s.L <= 12 ? 24 : s.L <= 72 ? 120 : 480 } }) },
  { id: 'bias-day', group: 'ICT & Candle Range Theory', name: 'Only with the day’s candle', plain: 'Longs only while price is above today’s opening price, shorts only below — trade with the candle that is forming (the CRT and ICT daily bias).', suits: ['scalp15', 'intraday15', 'scalp', 'intraday'], lean: 'trend', filter: { id: 'bias', p: { anchor: 0 } } },
  { id: 'bias-week', group: 'ICT & Candle Range Theory', name: 'Only with the week’s candle', plain: 'Longs only above the weekly open (Monday 00:00 UTC), shorts only below — the weekly bias.', suits: ['intraday', 'swing', 'week'], lean: 'trend', filter: { id: 'bias', p: { anchor: 1 } } },
  { id: 'kz-asia', group: 'ICT & Candle Range Theory', name: 'Only in the Asian kill zone', plain: 'Trades only from 20:00 to midnight New York time, when Asia opens — the quiet hours where ranges are built.', suits: ['scalp15', 'intraday15', 'scalp'], lean: 'session', filter: { id: 'killzone', p: { z: 4 } } },
  { id: 'kz-london', group: 'ICT & Candle Range Theory', name: 'Only in the London kill zone', plain: 'Trades only from 02:00 to 05:00 New York time, when London opens.', suits: ['scalp15', 'intraday15', 'scalp'], lean: 'session', filter: { id: 'killzone', p: { z: 0 } } },
  { id: 'macro', group: 'ICT & Candle Range Theory', name: 'Only in the ICT macros', plain: 'Trades only in ICT’s macro windows — short slots such as 09:50–10:10 New York time when, he teaches, price seeks liquidity. Best on 15-minute candles.', suits: ['scalp15', 'intraday15'], lean: 'session', filter: { id: 'macro', p: { set: 0 } } },
  { id: 'bias-yday', group: 'ICT & Candle Range Theory', name: 'Only with yesterday’s candle', plain: 'Longs only after a green day, shorts only after a red one — the daily bias Candle Range Theory reads from the last candle.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], lean: 'trend', filter: { id: 'bias', p: { anchor: 3 } } },
  { id: 'bias-lweek', group: 'ICT & Candle Range Theory', name: 'Only with last week’s candle', plain: 'Longs only after a green week, shorts only after a red one — the weekly bias.', suits: ['intraday', 'swing', 'week'], lean: 'trend', filter: { id: 'bias', p: { anchor: 4 } } },
  { id: 'structure', group: 'Smart Money Concepts', name: 'Only with the market structure', plain: 'Longs only while the swing structure is up (the last break was upward), shorts only while it is down — the first rule of Smart Money Concepts.', suits: ['scalp15', 'intraday15', 'scalp', 'intraday', 'swing'], lean: 'trend', filter: (s) => ({ id: 'structure', p: { k: s.L <= 12 ? 3 : s.L <= 72 ? 5 : 10 } }) },
  { id: 'crowd', group: 'Funding', name: 'Avoid crowded trades (funding)', plain: 'No longs when longs are paying heavy funding, no shorts when shorts are — do not join an overcrowded side.', lean: 'crowd', filter: { id: 'crowd', p: { band: 0.2 } } },
];

// ---------- 3. forecasts (second opinions) and the AI decision maker ----------

export interface ForecastOption extends Option {
  filter: RuleRef;
  /** the strategy it is the same model as (a second opinion from itself adds nothing) */
  same?: string;
  trend?: boolean;
}

export const FORECASTS: ForecastOption[] = [
  { id: 'kalman', group: 'Second opinion', name: 'The Kalman trend must agree', plain: 'Trade only in the direction the smart trend line is pointing.', filter: { id: 'agree', p: { model: 3 } }, same: 'kalman', trend: true },
  { id: 'nn', group: 'Second opinion', name: 'The AI neural network must agree', plain: 'Trade only when the neural network’s forecast of the next day points the same way.', filter: { id: 'agree', p: { model: 4 } }, same: 'nn' },
  { id: 'forest', group: 'Second opinion', name: 'The AI random forest must agree', plain: 'Trade only when the forest’s forecast of the next day points the same way.', filter: { id: 'agree', p: { model: 2 } }, same: 'rf' },
  { id: 'ridge', group: 'Second opinion', name: 'The AI linear forecast must agree', plain: 'Trade only when the regression forecast of the next day points the same way.', filter: { id: 'agree', p: { model: 1 } }, same: 'ols' },
  { id: 'candle', group: 'Second opinion', name: 'The AI next-candle forecast must agree', plain: 'Trade only when the candle-shape forecast expects the next candle to go the same way.', suits: ['scalp', 'intraday'], filter: { id: 'agree', p: { model: 0 } }, same: 'candle' },
];

export type Decider = 'none' | 'forest' | 'nn' | 'both';
export const DECIDERS: { id: Decider; name: string; plain: string }[] = [
  { id: 'none', name: 'No AI decision maker', plain: 'Every signal that passes the filters is taken.' },
  { id: 'forest', name: 'Decision forest', plain: 'A random forest studies the bot’s own past trades and learns which of its signals tend to lose; it skips those. Kept only if it passes a check inside the training years — the unseen data is never used to choose it.' },
  { id: 'nn', name: 'Neural network', plain: 'A neural network does the same job: it learns from the bot’s past trades which signals to skip. Kept only if it passes the same check inside the training years.' },
  { id: 'both', name: 'Neural network + decision forest, paired', plain: 'Both learn from the bot’s past trades; their odds are averaged, so a trade needs the pair to lean yes. Two different learners usually make steadier calls than either alone.' },
];

// ---------- 4. risk management ----------

export interface RiskOption extends Option {
  sizing?: (s: Style) => Sizing;
  garchStop?: boolean;
  hedge?: boolean;
}

export const RISKS: RiskOption[] = [
  { id: 'voltarget', group: 'Position size', name: 'Steady risk (volatility targeting)', plain: 'Smaller positions when the market is wild, bigger when calm, so the bot’s ups and downs stay steady. Usually lifts results.', sizing: (s) => ({ mode: 'vol', target: s.L <= 24 ? 1 : s.L >= 720 ? 0.4 : 0.6 }) },
  { id: 'var', group: 'Position size', name: 'Cap the daily loss (value at risk)', plain: 'Sizes each position so a bad day (the worst 1 in 100) costs about 5 % of the account at most.', sizing: () => ({ mode: 'var', target: 0.05 }) },
  { id: 'kelly', group: 'Position size', name: 'Kelly criterion (half Kelly)', plain: 'Works out from the bot’s own past trades how much of the account to risk per trade for the fastest growth, then risks half of that — most of the growth, far smaller swings.', sizing: () => ({ mode: 'kelly', target: 0 }) },
  { id: 'garchstop', group: 'Stops', name: 'Stops that widen before storms (GARCH)', plain: 'The stop distance follows GARCH’s forecast of volatility, so it gives the trade more room before a storm, not after.', garchStop: true },
  { id: 'hedged', group: 'Hedging', name: 'Market-neutral (hedge with bitcoin)', plain: 'Shorts the right amount of bitcoin against each trade (CAPM beta), so you keep the coin’s own move and not the whole market’s. Needs BTC among the coins.', hedge: true },
];

export const PORTFOLIOS: { id: NonNullable<StrategySpec['weights']>; name: string; plain: string }[] = [
  { id: 'equal', name: 'Equal split', plain: 'The same money on every coin.' },
  { id: 'invvol', name: 'More on calmer coins (inverse volatility)', plain: 'Each coin gets money in proportion to how calm it has been, so every coin contributes about the same risk.' },
  { id: 'minvar', name: 'Smoothest mix (minimum variance)', plain: 'The split across coins that made the bot’s combined result swing the least on the training years.' },
  { id: 'tangency', name: 'Best return for the risk (efficient frontier)', plain: 'Markowitz’s efficient frontier: the split with the best return for its risk on the training years. Powerful but sensitive — judged on the unseen years like everything else.' },
];

export const STOP_WIDTHS = [
  { id: 'tight', name: 'Tight stop', plain: 'Cuts losers fast; more small losses.', k: 0.7 },
  { id: 'normal', name: 'Normal stop', plain: 'The usual room for this style.', k: 1 },
  { id: 'wide', name: 'Wide stop', plain: 'Gives trades room to breathe; fewer, bigger losses.', k: 1.5 },
];

// ---------- 5. the rules of engagement ----------

export const SIDES = [
  { id: 'both', name: 'Long and short', plain: 'Profit from rises and falls.' },
  { id: 'long', name: 'Long only', plain: 'Only buys; never bets on falls.' },
  { id: 'short', name: 'Short only', plain: 'Only bets on falls.' },
] as const;

export const TAKE_PROFIT = [
  { id: 'trail', name: 'Let winners run (trailing stop)', plain: 'Once a trade is 1R up, the stop follows the price, locking in gains.', targetR: 0, trail: true },
  { id: 'r15', name: 'Take profit at 1.5× the risk', plain: 'Closes when the gain is 1.5 times what was risked.', targetR: 1.5, trail: false },
  { id: 'r2', name: 'Take profit at 2× the risk', plain: 'Closes at twice the risk.', targetR: 2, trail: false },
  { id: 'r3', name: 'Take profit at 3× the risk', plain: 'Closes at three times the risk; wins less often, bigger when it does.', targetR: 3, trail: false },
  { id: 'none', name: 'No profit target', plain: 'Exits only on the stop, the time limit or an opposite signal.', targetR: 0, trail: false },
];

export const HOLDS = [
  { id: 'half', name: 'Shorter hold', plain: 'Half the style’s usual holding time.', k: 0.5 },
  { id: 'normal', name: 'Usual hold', plain: 'The style’s usual holding time.', k: 1 },
  { id: 'long', name: 'Longer hold', plain: 'Twice the style’s usual holding time.', k: 2 },
];

// ---------- the chain ----------

export interface Flow {
  style: StyleId;
  strategies: string[];
  combine: Combine;
  models: string[];
  forecasts: string[];
  decider: Decider;
  risks: string[];
  portfolio: NonNullable<StrategySpec['weights']>;
  stopWidth: string;
  sides: 'both' | 'long' | 'short';
  takeProfit: string;
  hold: string;
  flip: boolean;
  coins: string;
  /** who decides its trades once deployed: the swarm's council, or the bot as tested (only Guardian and Risk can stop it) */
  authority: 'council' | 'tested';
  /**
   * settings carried by a pick, over the style's defaults — keyed `block:id`
   * ('strategy:nn', 'forecast:nn', 'risk:var', 'decider'). The Quant desk
   * sends a model in with the settings it was studied with (lab/bridge.ts).
   */
  tunes?: Record<string, Params>;
}

export const FLOW_DEFAULT: Flow = { style: 'swing', strategies: ['tsmom'], combine: 'all', models: ['trend'], forecasts: [], decider: 'none', risks: ['voltarget'], portfolio: 'equal', stopWidth: 'normal', sides: 'both', takeProfit: 'trail', hold: 'normal', flip: true, coins: 'BTC ETH SOL', authority: 'council' };

/** a saved chain from the first bot builder (one pick per block) as today's chain */
export function migrateFlow(f: Partial<Flow> & Record<string, unknown>): Flow {
  const out = { ...FLOW_DEFAULT, ...f } as Flow & Record<string, unknown>;
  if (!Array.isArray(f.strategies) && typeof f.strategy === 'string') out.strategies = [f.strategy];
  if (!Array.isArray(f.models) && (typeof f.model === 'string' || typeof f.model2 === 'string')) out.models = [f.model, f.model2].filter((x): x is string => typeof x === 'string' && x !== 'none');
  if (!Array.isArray(f.forecasts) && typeof f.forecast === 'string') {
    out.forecasts = f.forecast !== 'none' && f.forecast !== 'meta' ? [f.forecast] : [];
    if (f.forecast === 'meta' && !f.decider) out.decider = 'forest';
  }
  if (!Array.isArray(f.risks) && typeof f.risk === 'string') out.risks = f.risk === 'steady-garch' ? ['voltarget', 'garchstop'] : f.risk === 'fixed' ? [] : [f.risk];
  // only known picks
  out.strategies = out.strategies.filter((id) => STRATEGIES.some((s) => s.id === id));
  if (!out.strategies.length) out.strategies = [...FLOW_DEFAULT.strategies];
  out.models = out.models.filter((id) => MODELS.some((s) => s.id === id));
  out.forecasts = out.forecasts.filter((id) => FORECASTS.some((s) => s.id === id));
  out.risks = out.risks.filter((id) => RISKS.some((s) => s.id === id));
  for (const k of ['strategy', 'model', 'model2', 'forecast', 'risk']) delete out[k];
  // settings only for picks that are still made, numbers only
  const live = new Set([...out.strategies.map((id) => `strategy:${id}`), ...out.models.map((id) => `model:${id}`), ...out.forecasts.map((id) => `forecast:${id}`), ...out.risks.map((id) => `risk:${id}`), ...(out.decider === 'nn' || out.decider === 'both' ? ['decider'] : [])]);
  const tunes: Record<string, Params> = {};
  if (f.tunes && typeof f.tunes === 'object')
    for (const [k, v] of Object.entries(f.tunes as Record<string, unknown>)) {
      if (!live.has(k) || !v || typeof v !== 'object') continue;
      const nums = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'number' && Number.isFinite(x))) as Params;
      if (Object.keys(nums).length) tunes[k] = nums;
    }
  if (Object.keys(tunes).length) out.tunes = tunes;
  else delete out.tunes;
  return out;
}

const find = <T extends { id: string }>(xs: readonly T[], id: string) => xs.find((x) => x.id === id) ?? xs[0];
const holdText = (h: number) => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} hours`);
const sameRule = (a: RuleRef, b: RuleRef) => a.id === b.id && JSON.stringify(a.p) === JSON.stringify(b.p);

/** “setup, then trigger”: how many candles after the setup the trigger may come (a quarter of the style's look-back) */
export const thenWindow = (s: Style) => clamp(Math.round(s.L / s.tfH / 4), 2, 24);

/** the chain as the Strategy Lab's strategy, its timeframe and history to test on */
export function buildSpec(f0: Flow): { spec: StrategySpec; style: Style; timeframe: Style['timeframe']; years: number; coins: string[]; summary: string[] } {
  const f = migrateFlow(f0 as Flow & Record<string, unknown>);
  const style = STYLE_MAP[f.style] ?? STYLE_MAP.swing;
  const strats = f.strategies.map((id) => find(STRATEGIES, id));
  const tune = (key: string): Params => f.tunes?.[key] ?? {};
  const rules = strats.map((s) => ({ id: s.signal, p: { ...s.params(style), ...tune(`strategy:${s.id}`) } }));
  const filters: RuleRef[] = [];
  const add = (r: RuleRef) => !filters.some((x) => sameRule(x, r)) && filters.push(r);
  for (const id of f.models) {
    const m = find(MODELS, id);
    const r = typeof m.filter === 'function' ? m.filter(style) : m.filter;
    add({ id: r.id, p: { ...r.p, ...tune(`model:${id}`) } });
  }
  for (const id of f.forecasts) {
    const r = find(FORECASTS, id).filter;
    add({ id: r.id, p: { ...r.p, ...tune(`forecast:${id}`) } });
  }
  const risks = f.risks.map((id) => find(RISKS, id));
  const sizings = risks
    .filter((r) => r.sizing)
    .map((r) => {
      const z = r.sizing!(style);
      const t = tune(`risk:${r.id}`).target;
      return t > 0 ? { ...z, target: t } : z;
    });
  const garchStop = risks.some((r) => r.garchStop);
  const hedge = risks.some((r) => r.hedge);
  const width = find(STOP_WIDTHS, f.stopWidth);
  const tp = find(TAKE_PROFIT, f.takeProfit);
  const hold = find(HOLDS, f.hold);
  const stop = Math.round(style.stop * width.k * 10) / 10;
  // a rule with a holding time of its own (a two-hour window, one day) is never held longer than that
  const own = Math.min(...strats.map((s) => s.holdH ?? Infinity));
  const holdH = Math.min(style.holdH * hold.k, own);
  const maxBars = Math.max(1, Math.round(holdH / style.tfH));
  let coins = f.coins.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 8);
  if ((hedge || strats.some((s) => s.needsBtc)) && !coins.includes('BTC')) coins = ['BTC', ...coins];
  const net = tune('decider');
  const spec: StrategySpec = {
    name: '',
    signal: rules[0],
    ...(rules.length > 1 ? { also: rules.slice(1), combine: f.combine } : {}),
    ...(rules.length > 1 && f.combine === 'then' ? { window: thenWindow(style) } : {}),
    filters,
    exit: { ...EXIT_DEFAULT, stopAtr: stop, targetR: tp.targetR, trailAtr: tp.trail ? Math.max(1.5, stop) : 0, maxBars, onFlip: f.flip, stopVol: garchStop ? Math.max(2, Math.round(stop * 1.3)) : 0 },
    sides: f.sides,
    ...(sizings[0] ? { sizing: sizings[0] } : {}),
    ...(sizings[1] ? { sizing2: sizings[1] } : {}),
    ...(hedge ? { hedge: 'btc' as const } : {}),
    ...(f.decider !== 'none' ? { autoMeta: f.decider } : {}),
    ...(f.decider !== 'none' && f.decider !== 'forest' && net.h1 > 0 ? { metaNet: [Math.round(net.h1), Math.round(net.h2 > 0 ? net.h2 : Math.max(2, net.h1 / 2))] as [number, number] } : {}),
    ...(f.portfolio !== 'equal' && coins.length > 1 ? { weights: f.portfolio } : {}),
  };
  const joined = f.combine === 'all' ? ' + ' : f.combine === 'majority' ? ' ⋅maj⋅ ' : f.combine === 'switch' ? ' ⇄ ' : f.combine === 'then' ? ' → ' : ' | ';
  spec.name = [strats.map((s) => s.name).join(joined), ...filters.map((x) => FILTER_MAP[x.id]?.name).filter(Boolean), style.name.split(' — ')[0]].join(' · ');
  const comb = COMBINES.find((c) => c.id === f.combine)!;
  const summary = [
    `${style.name}: ${style.timeframe} candles, up to ${holdText(holdH)} a trade`,
    rules.length > 1 ? `Enters (${comb.name.toLowerCase()}): ${rules.map((r) => SIGNAL_MAP[r.id].describe(r.p)).join('; ')}` : `Enters: ${SIGNAL_MAP[rules[0].id].describe(rules[0].p)}`,
    ...filters.map((x) => `Only: ${FILTER_MAP[x.id].describe(x.p)}`),
    ...(f.decider !== 'none' ? [`Decides: ${DECIDERS.find((d) => d.id === f.decider)!.name.toLowerCase()} learns which signals to skip (kept only if it helps in a check inside the training years)`] : []),
    `Risk: ${risks.length ? risks.map((r) => r.name.toLowerCase()).join(' + ') : 'fixed size'}${sizings.length > 1 ? ' (the smaller size wins)' : ''} — stop ${garchStop ? `${spec.exit.stopVol} GARCH σ` : `${stop} ATR`}`,
    ...(spec.weights ? [`Split: ${PORTFOLIOS.find((p) => p.id === f.portfolio)!.name.toLowerCase()}, fitted on the training years`] : []),
    `Exits: ${tp.name.toLowerCase()}${f.flip ? ', or on an opposite signal' : ''}, at most ${holdText(holdH)}`,
    `${f.sides === 'both' ? 'Long and short' : f.sides === 'long' ? 'Long only' : 'Short only'} on ${coins.join(', ')}`,
  ];
  return { spec, style, timeframe: style.timeframe, years: style.years, coins, summary };
}

/** options sorted with the ones that suit the style first */
export function forStyle<T extends Option>(xs: T[], style: StyleId): (T & { fits: boolean })[] {
  const as = STYLE_MAP[style]?.like ?? style;
  return xs.map((x) => ({ ...x, fits: !x.suits || x.suits.includes(as) })).sort((a, b) => Number(b.fits) - Number(a.fits));
}

// ---------- the compatibility check: clash, overlap, pair ----------

export type BlockId = 'style' | 'strategy' | 'model' | 'forecast' | 'risk' | 'rules' | 'test' | 'deploy';
export interface Finding {
  tone: 'clash' | 'overlap' | 'pair' | 'info';
  /** the blocks it concerns */
  blocks: BlockId[];
  /** the picks it concerns (option ids) */
  picks: string[];
  text: string;
}

const famOf = (id: string): Family => SIGNAL_MAP[find(STRATEGIES, id).signal]?.family ?? 'trend';
const isTrend = (f: Family) => f === 'trend' || f === 'momentum';
const nameOf = (xs: readonly Option[], id: string) => xs.find((x) => x.id === id)?.name ?? id;
const sq = (s: string) => `“${s}”`;

/**
 * Read a chain and say, block by block, which picks clash (they work against
 * each other), overlap (they say much the same thing) or pair well (they add
 * to each other) — from what each one does, before any test. The backtest then
 * measures it on the data.
 */
export function checkFlow(f0: Flow): Finding[] {
  const f = migrateFlow(f0 as Flow & Record<string, unknown>);
  const out: Finding[] = [];
  const style = STYLE_MAP[f.style] ?? STYLE_MAP.swing;
  const S = f.strategies.map((id) => find(STRATEGIES, id));
  const M = f.models.map((id) => find(MODELS, id));
  const F = f.forecasts.map((id) => find(FORECASTS, id));
  const R = f.risks.map((id) => find(RISKS, id));
  const push = (tone: Finding['tone'], blocks: BlockId[], picks: string[], text: string) => out.push({ tone, blocks, picks, text });

  // the style
  for (const s of S) {
    const sig = SIGNAL_MAP[s.signal];
    if (sig.intraday && style.tfH >= 24) push('clash', ['style', 'strategy'], [s.id], `${sq(s.name)} needs candles shorter than a day — pick scalping, intraday, swing or one-week.`);
    if (s.id === 'fade' && style.tfH >= 1) push('info', ['style', 'strategy'], [s.id], `${sq(s.name)} was measured on 15-minute candles — on ${style.timeframe} candles the snap-back it trades is mostly over before the candle closes. Choose a 15-minute style.`);
    else if (s.suits && !s.suits.includes(style.like ?? f.style)) push('info', ['style', 'strategy'], [s.id], `${sq(s.name)} is usually traded on ${s.suits.map((x) => STYLE_MAP[x].name.split(' — ')[0].toLowerCase()).join(', ')} — it can still work here; the test will tell.`);
  }
  for (const m of M) if (m.lean === 'session' && style.tfH >= 24) push('clash', ['style', 'model'], [m.id], `${sq(m.name)} on daily candles: a day has no trading hours to pick — remove it or choose a shorter style.`);

  // the strategies, two by two
  for (let i = 0; i < S.length; i++)
    for (let j = i + 1; j < S.length; j++) {
      const a = S[i];
      const b = S[j];
      const fa = famOf(a.id);
      const fb = famOf(b.id);
      const pair = [a.id, b.id];
      const both = `${sq(a.name)} and ${sq(b.name)}`;
      if (a.mixed || b.mixed) {
        if (f.combine === 'all' && a.nature === 'event' && b.nature === 'event') push('info', ['strategy'], pair, `${both} each fire only now and then; with “all must agree” both must fire on the same candle — expect very few trades (or choose “any one”).`);
        continue;
      }
      if (fa === 'relative' && fb === 'relative') {
        if ((a.id === 'rsbtc') !== (b.id === 'rsbtc') && (a.id === 'pairs' || b.id === 'pairs')) push('clash', ['strategy'], pair, `${both} bet opposite ways on the same thing: one that the coin’s gap to bitcoin closes, the other that it keeps widening. Pick one.`);
        else push('overlap', ['strategy'], pair, `${both} both trade the coin’s gap to bitcoin — much the same idea, read two ways.`);
        continue;
      }
      const trendRev = (isTrend(fa) && fb === 'reversion') || (isTrend(fb) && fa === 'reversion');
      const breakRev = (fa === 'breakout' && fb === 'reversion') || (fb === 'breakout' && fa === 'reversion');
      if ((trendRev || breakRev) && f.combine === 'switch') push('pair', ['strategy'], pair, `${both} pair well with the regime switch: the ${isTrend(fa) || fa === 'breakout' ? sq(a.name) : sq(b.name)} rule trades while the market trends, the dip rule while it ranges — each in the market it was made for.`);
      else if (trendRev) {
        const st = isTrend(fa) ? a : b;
        if (f.combine === 'all' && st.nature === 'state') push('pair', ['strategy'], pair, `${both} pair well with “all must agree”: the trend rule picks the side, the dip rule picks the moment — buy the dips in an uptrend, sell the rallies in a downtrend.`);
        else push('clash', ['strategy'], pair, `${both} pull opposite ways: one follows moves, the other bets they reverse. With “${COMBINES.find((c) => c.id === f.combine)!.name.toLowerCase()}” they will cancel out or flip-flop — use “all must agree” so the trend picks the side and the dip the moment, or the “regime switch” so each trades its own market.`);
      } else if (breakRev) push('clash', ['strategy'], pair, `${both} fight by design: one buys strength, the other sells it. They will rarely agree — pick one, or join them with the “regime switch” so each trades its own market.`);
      else if (fa === fb && fa !== 'ml') push('overlap', ['strategy'], pair, `${both} are both ${fa === 'reversion' ? 'dip-buying' : fa === 'breakout' ? 'breakout' : fa === 'seasonal' ? 'calendar' : fa === 'carry' ? 'funding' : fa === 'volume' ? 'volume' : 'trend'} rules — they will mostly say the same thing. Together they confirm each other; they do not add a new idea.`);
      else if (isTrend(fa) && isTrend(fb)) push('overlap', ['strategy'], pair, `${both} both follow the trend — mostly the same signal; together they act as confirmation.`);
      else if (fa === 'ml' && fb === 'ml') push('pair', ['strategy'], pair, `${both} are two different AI models — when both point the same way, the call is stronger than either alone.`);
      else if (fa === 'ml' || fb === 'ml') push('pair', ['strategy'], pair, `${both}: an AI model alongside a rule — a learned view checks a simple one.`);
      else if ((fa === 'breakout' && isTrend(fb)) || (fb === 'breakout' && isTrend(fa))) push('pair', ['strategy'], pair, `${both} pair well: a breakout starts trends and the trend rule confirms it.`);
      else if (fa === 'carry' || fb === 'carry') push('pair', ['strategy'], pair, `${both}: getting paid funding alongside a price rule — two unrelated sources of edge.`);
      if (f.combine === 'all' && a.nature === 'event' && b.nature === 'event') push('info', ['strategy'], pair, `${both} each fire only now and then; with “all must agree” both must fire on the same candle — expect very few trades (or choose “any one”).`);
    }
  if (S.length >= 3 && f.combine === 'all') push('info', ['strategy'], S.map((s) => s.id), `${S.length} strategies that must all agree will trade rarely — “majority vote” keeps the confirmation with more trades.`);
  if (S.length >= 2 && f.combine === 'switch') {
    const sides = S.map((x) => regimeSide(famOf(x.id)));
    if (!(sides.includes('trend') && sides.includes('range'))) push('info', ['strategy'], S.map((x) => x.id), `The regime switch needs a trend or breakout strategy and a dip-buying one to switch between; with these picks it works like “any one”.`);
  }
  if (S.length >= 2 && f.combine === 'then') push('info', ['strategy'], S.map((x) => x.id), `Setup, then trigger: ${sq(S[0].name)} sets the direction, and the trade is taken when ${S.slice(1).map((x) => sq(x.name)).join(' and ')} ${S.length > 2 ? 'confirm' : 'confirms'} it within ${thenWindow(style)} candles. The first pick is the setup — reorder the picks to change it.`);

  // the strategies against the market models
  const sfam = S.map((s) => ({ s, fam: famOf(s.id) }));
  for (const m of M) {
    for (const { s, fam } of sfam) {
      const both = `${sq(s.name)} with ${sq(m.name)}`;
      if (isTrend(fam) && m.lean === 'range') push('clash', ['strategy', 'model'], [s.id, m.id], `${both}: a trend rule only allowed to trade when there is no trend — they work against each other.`);
      else if (fam === 'reversion' && m.lean === 'trend' && m.id !== 'trend') push('clash', ['strategy', 'model'], [s.id, m.id], `${both}: a dip-buying rule only allowed in strong trends, where dips keep going — they work against each other.`);
      else if (fam === 'reversion' && m.id === 'trend') push('pair', ['strategy', 'model'], [s.id, m.id], `${both}: buy dips only in an uptrend (and sell rallies only in a downtrend) — a classic pairing.`);
      else if (fam === 'breakout' && m.lean === 'calm') push('clash', ['strategy', 'model'], [s.id, m.id], `${both}: breakouts need movement, and this filter only trades when it is quiet.`);
      else if (fam === 'breakout' && m.lean === 'storm') push('pair', ['strategy', 'model'], [s.id, m.id], `${both}: breakouts with fuel behind them.`);
      else if (isTrend(fam) && m.lean === 'trend') push('pair', ['strategy', 'model'], [s.id, m.id], `${both}: the trend rule trades only when the market is really trending.`);
      else if (m.lean === 'market' && fam === 'relative') push('info', ['strategy', 'model'], [s.id, m.id], `${both}: a trade against bitcoin does not depend on which way bitcoin is going — this filter mostly just removes trades.`);
      else if (m.lean === 'market' && isTrend(fam)) push('pair', ['strategy', 'model'], [s.id, m.id], `${both}: the coin’s trend with the whole market behind it.`);
      else if (m.lean === 'market' && fam === 'reversion') push('pair', ['strategy', 'model'], [s.id, m.id], `${both}: buy dips only while bitcoin is in an uptrend, sell rallies only in a downtrend.`);
      else if (m.lean === 'weekends' && isTrend(fam)) push('info', ['strategy', 'model'], [s.id, m.id], `${both}: weekend moves follow through less — trend rules usually want the weekdays.`);
      else if (m.lean === 'weekends' && fam === 'reversion') push('pair', ['strategy', 'model'], [s.id, m.id], `${both}: dip-buying in the thin, quiet weekend market, where moves fade more often.`);
      else if (isTrend(fam) && m.lean === 'calm') push('pair', ['strategy', 'model'], [s.id, m.id], `${both}: trend rules suffer most in storms — stepping aside then usually helps.`);
      else if (fam === 'reversion' && m.lean === 'range') push('pair', ['strategy', 'model'], [s.id, m.id], `${both}: dip-buying where prices have been snapping back.`);
    }
  }
  // the market models among themselves
  const leans = (l: Lean) => M.filter((m) => m.lean === l);
  const opp: [Lean, Lean][] = [
    ['trend', 'range'],
    ['calm', 'storm'],
  ];
  for (const [x, y] of opp)
    for (const a of leans(x))
      for (const b of leans(y)) {
        const sameModel = (typeof a.filter === 'function' ? a.filter(style) : a.filter).id === (typeof b.filter === 'function' ? b.filter(style) : b.filter).id;
        push('clash', ['model'], [a.id, b.id], sameModel ? `${sq(a.name)} and ${sq(b.name)} are opposites — never both true, so the bot would never trade.` : `${sq(a.name)} and ${sq(b.name)} ask for opposite markets — they will rarely both be true, leaving very few trades.`);
      }
  for (const l of ['trend', 'range', 'calm', 'storm'] as Lean[]) {
    const g = leans(l);
    if (g.length > 1) push('overlap', ['model'], g.map((m) => m.id), `${g.map((m) => sq(m.name)).join(' and ')} measure much the same thing (${l === 'trend' ? 'a trending market' : l === 'range' ? 'a ranging market' : l === 'calm' ? 'a calm market' : 'a stormy market'}) — together they are stricter, not smarter.`);
  }
  if (leans('weekdays').length && leans('weekends').length) push('clash', ['model'], [...leans('weekdays'), ...leans('weekends')].map((m) => m.id), '“Only on weekdays” and “Only at weekends” are opposites — never both true, so the bot would never trade.');
  for (const m of [...leans('weekdays'), ...leans('weekends')]) {
    const timed = S.find((s) => s.id === 'dow');
    if (timed && m.lean === 'weekends') push('clash', ['strategy', 'model'], [timed.id, m.id], `${sq(timed.name)} trades on Mondays — with ${sq(m.name)} it never trades.`);
  }
  const sess = leans('session');
  if (sess.length > 1) push('info', ['model'], sess.map((m) => m.id), `Both sessions together leave only the hours they share (13:00–16:00 UTC).`);

  // the second opinions
  for (const fc of F) {
    const same = S.find((s) => s.id === fc.same);
    if (same) push('overlap', ['strategy', 'forecast'], [same.id, fc.id], `${sq(fc.name)} is the same model as the strategy ${sq(same.name)} — asking it for a second opinion adds nothing.`);
    else if (fc.trend && sfam.some((x) => isTrend(x.fam))) push('overlap', ['strategy', 'forecast'], [fc.id, ...sfam.filter((x) => isTrend(x.fam)).map((x) => x.s.id)], `${sq(fc.name)} is another trend reading on top of a trend strategy — confirmation, not a new view.`);
    else if (fc.trend && sfam.some((x) => x.fam === 'reversion')) push('pair', ['strategy', 'forecast'], [fc.id], `${sq(fc.name)} with a dip-buying strategy: buy dips only while the trend line points up.`);
    else push('pair', ['strategy', 'forecast'], [fc.id], `${sq(fc.name)} adds an independent view to the strategy.`);
  }
  if (F.length > 1) {
    const ai = F.filter((x) => !x.trend);
    if (ai.length > 1) push('pair', ['forecast'], ai.map((x) => x.id), `${ai.map((x) => sq(x.name)).join(' and ')}: different AI models must all agree — fewer trades, each better confirmed.`);
  }
  if (f.decider === 'both') push('pair', ['forecast'], ['both'], 'The neural network and the decision forest paired: each gives its odds that a signal wins and their average decides — two different learners usually make steadier calls than either alone.');
  if (f.decider !== 'none' && S.length + M.length + F.length >= 5) push('info', ['forecast'], [f.decider], 'With this many filters the AI decision maker may have fewer than 40 past trades to learn from — it says so after the test, and is only kept if it passes the check inside the training years.');

  // the strategies that trade against bitcoin
  const rel = S.filter((s) => s.needsBtc);
  if (rel.length) {
    const cs = f.coins.toUpperCase().split(/[\s,]+/).filter(Boolean);
    if (!cs.some((x) => x !== 'BTC')) push('clash', ['strategy', 'test'], rel.map((s) => s.id), `${rel.map((s) => sq(s.name)).join(' and ')} need${rel.length > 1 ? '' : 's'} a coin other than bitcoin to trade — add one (ETH, SOL …).`);
    else if (!cs.includes('BTC')) push('info', ['strategy', 'test'], rel.map((s) => s.id), `${rel.map((s) => sq(s.name)).join(' and ')} read${rel.length > 1 ? '' : 's'} bitcoin’s price: BTC is added to the coins it is tested on (it does not trade BTC itself).`);
    const pairsPick = S.find((s) => s.id === 'pairs');
    if (pairsPick && R.some((r) => r.hedge)) push('pair', ['strategy', 'risk'], ['pairs', 'hedged'], `${sq(pairsPick.name)} with the bitcoin hedge is the true pairs trade: long the cheap coin and short bitcoin (or the reverse), so the market’s direction cancels out.`);
    else if (pairsPick) push('info', ['strategy', 'risk'], ['pairs'], `${sq(pairsPick.name)} trades only the coin’s side of the pair. Add “Market-neutral (hedge with bitcoin)” in Risk to trade the gap itself, without the market’s direction.`);
  }
  // risk
  const sizes = R.filter((r) => r.sizing);
  if (sizes.length === 2) push('pair', ['risk'], sizes.map((r) => r.id), `${sizes.map((r) => sq(r.name)).join(' and ')} combine: each works out a size and the smaller one is used — ${sizes.some((r) => r.id === 'var') ? 'the value-at-risk budget acts as a ceiling' : 'the stricter rule wins each time'}.`);
  if (sizes.length > 2) push('clash', ['risk'], sizes.map((r) => r.id), `Only two sizing rules can be combined (the smaller size wins); ${sq(sizes.slice(2).map((r) => r.name).join(', '))} is ignored — remove one.`);
  if (R.some((r) => r.hedge)) {
    if (f.sides === 'long') push('pair', ['risk', 'rules'], ['hedged'], 'Long only, hedged with bitcoin: you hold each coin’s own move against the market — a market-neutral bot.');
    if (!f.coins.toUpperCase().split(/[\s,]+/).includes('BTC')) push('info', ['risk', 'test'], ['hedged'], 'The bitcoin hedge needs BTC’s prices: BTC is added to the coins it is tested on.');
  }
  if (R.some((r) => r.id === 'kelly') && f.takeProfit === 'none' && !f.flip) push('info', ['risk', 'rules'], ['kelly'], 'Kelly sizing needs clear wins and losses to measure; with no target and no exit on an opposite signal, most trades end on the time limit.');
  const coinN = f.coins.split(/[\s,]+/).filter(Boolean).length;
  if (f.portfolio !== 'equal' && coinN < 2) push('info', ['risk', 'test'], [f.portfolio], 'Splitting money across coins needs two or more coins.');
  if (f.portfolio === 'tangency') push('info', ['risk'], ['tangency'], 'The efficient frontier leans on past returns, the noisiest number in finance — it is fitted on the training years only and judged on the unseen ones; compare it with “more on calmer coins”.');
  // rules
  for (const s of S.filter((x) => x.longOnly)) if (f.sides === 'short') push('clash', ['rules', 'strategy'], [s.id], `${sq(s.name)} only ever buys — with short only, it never trades.`);
  if (f.takeProfit !== 'trail' && f.takeProfit !== 'none' && S.some((s) => isTrend(famOf(s.id))) && f.style !== 'scalp') push('info', ['rules', 'strategy'], [f.takeProfit], 'A fixed profit target caps a trend strategy’s big winners — trend rules usually do better letting winners run.');
  return out;
}

/** the worst tone a block has (for its badge) */
export function blockTone(fs: Finding[], b: BlockId): Finding['tone'] | null {
  const mine = fs.filter((x) => x.blocks.includes(b));
  return mine.some((x) => x.tone === 'clash') ? 'clash' : mine.some((x) => x.tone === 'overlap') ? 'overlap' : mine.some((x) => x.tone === 'pair') ? 'pair' : mine.length ? 'info' : null;
}

/** a verdict in words for a tested bot */
export function verdictWords(oosSharpe: number, t: number, trades: number): { tone: 'good' | 'ok' | 'bad'; text: string } {
  if (trades < 10) return { tone: 'bad', text: 'Too few trades to judge — try another style, more coins or a looser filter.' };
  if (oosSharpe > 1 && t > 2) return { tone: 'good', text: 'Strong on data it never saw: good return for the risk, and unlikely to be luck.' };
  if (oosSharpe > 0.5 && t > 1.5) return { tone: 'ok', text: 'Promising on unseen data, but not yet proven — it could still be luck.' };
  if (oosSharpe > 0) return { tone: 'ok', text: 'Made a little on unseen data, but not enough for its risk to be convincing.' };
  return { tone: 'bad', text: 'Lost money on data it never saw. Do not deploy it as it is.' };
}

/** the measured verdict on a pair of strategies, in words */
export function pairWords(v: 'redundant' | 'clash' | 'complement', corr: number, agree: number): string {
  const a = Number.isFinite(agree) ? `${Math.round(agree * 100)} % of the time they were both on, they agreed` : 'they were never on at the same time';
  if (v === 'redundant') return `They move together (correlation ${corr.toFixed(2)}) — mostly the same signal. ${a}.`;
  if (v === 'clash') return `They disagree (correlation ${corr.toFixed(2)}) — ${a}.`;
  return `They are different views (correlation ${corr.toFixed(2)}) — ${a}. Combining different views is what adds information.`;
}

/** the names of picks, for the canvas */
export const pickName = {
  strategy: (id: string) => nameOf(STRATEGIES, id),
  model: (id: string) => nameOf(MODELS, id),
  forecast: (id: string) => nameOf(FORECASTS, id),
  risk: (id: string) => nameOf(RISKS, id),
};
