/**
 * Exact decimal arithmetic on plain strings such as "1234.50".
 *
 * Decimals are never converted to a double, so money and quantities can't lose digits.
 * Input text is accepted as is and is never normalized by these functions, apart from
 * results of arithmetic, which keep the largest input scale.
 */

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

const CODE_MINUS = 45;
const CODE_DOT = 46;
const CODE_ZERO = 48;

interface Scaled {
  unscaled: bigint;
  scale: number;
}

export function isDecimal(text: string): boolean {
  return DECIMAL_PATTERN.test(text);
}

function toScaled(text: string): Scaled {
  if (!isDecimal(text)) {
    throw new TypeError(`Not a decimal: ${JSON.stringify(text)}`);
  }
  const negative = text.charCodeAt(0) === CODE_MINUS;
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  const digits = dot === -1 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const scale = dot === -1 ? 0 : body.length - dot - 1;
  const magnitude = BigInt(digits);
  return { unscaled: negative ? -magnitude : magnitude, scale };
}

function fromScaled(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  let digits = (negative ? -unscaled : unscaled).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return negative ? `-${digits}` : digits;
}

function rescale(value: Scaled, scale: number): bigint {
  return value.unscaled * 10n ** BigInt(scale - value.scale);
}

/** Divides and rounds half away from zero. */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
}

export function decAdd(a: string, b: string): string {
  const x = toScaled(a);
  const y = toScaled(b);
  const scale = Math.max(x.scale, y.scale);
  return fromScaled(rescale(x, scale) + rescale(y, scale), scale);
}

export function decSub(a: string, b: string): string {
  const x = toScaled(a);
  const y = toScaled(b);
  const scale = Math.max(x.scale, y.scale);
  return fromScaled(rescale(x, scale) - rescale(y, scale), scale);
}

export function decMul(a: string, b: string): string {
  const x = toScaled(a);
  const y = toScaled(b);
  return fromScaled(x.unscaled * y.unscaled, x.scale + y.scale);
}

/** Division needs a target scale, because the exact result may not terminate. Rounds half away from zero. */
export function decDiv(a: string, b: string, scale: number): string {
  const x = toScaled(a);
  const y = toScaled(b);
  if (y.unscaled === 0n) {
    throw new RangeError('Division by zero');
  }
  const numerator = x.unscaled * 10n ** BigInt(scale + y.scale);
  const denominator = y.unscaled * 10n ** BigInt(x.scale);
  return fromScaled(divideRounded(numerator, denominator), scale);
}

/** Rounds half away from zero. */
export function decRound(value: string, scale: number): string {
  const x = toScaled(value);
  if (x.scale <= scale) {
    return fromScaled(rescale(x, scale), scale);
  }
  return fromScaled(divideRounded(x.unscaled, 10n ** BigInt(x.scale - scale)), scale);
}

/** Sums any number of values. An empty input gives "0". Null values are skipped. */
export function decSum(values: Iterable<string | null>): string {
  let total = 0n;
  let scale = 0;
  for (const value of values) {
    if (value === null) continue;
    const x = toScaled(value);
    if (x.scale > scale) {
      total *= 10n ** BigInt(x.scale - scale);
      scale = x.scale;
    }
    total += rescale(x, scale);
  }
  return fromScaled(total, scale);
}

function isZeroText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== CODE_ZERO && code !== CODE_DOT && code !== CODE_MINUS) return false;
  }
  return true;
}

function compareMagnitude(a: string, aStart: number, b: string, bStart: number): number {
  let i = aStart;
  while (i < a.length - 1 && a.charCodeAt(i) === CODE_ZERO && a.charCodeAt(i + 1) !== CODE_DOT) i++;
  let j = bStart;
  while (j < b.length - 1 && b.charCodeAt(j) === CODE_ZERO && b.charCodeAt(j + 1) !== CODE_DOT) j++;

  const aDot = a.indexOf('.', i);
  const bDot = b.indexOf('.', j);
  const aIntEnd = aDot === -1 ? a.length : aDot;
  const bIntEnd = bDot === -1 ? b.length : bDot;

  const lengthDifference = aIntEnd - i - (bIntEnd - j);
  if (lengthDifference !== 0) return lengthDifference < 0 ? -1 : 1;

  while (i < aIntEnd) {
    const difference = a.charCodeAt(i++) - b.charCodeAt(j++);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }

  // Fractions compare digit by digit, and a missing digit counts as zero.
  let m = aDot === -1 ? a.length : aDot + 1;
  let n = bDot === -1 ? b.length : bDot + 1;
  while (m < a.length || n < b.length) {
    const x = m < a.length ? a.charCodeAt(m++) : CODE_ZERO;
    const y = n < b.length ? b.charCodeAt(n++) : CODE_ZERO;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Exact numeric comparison with no allocation, so sorting many decimals stays fast. */
export function decCompare(a: string, b: string): number {
  const aNegative = a.charCodeAt(0) === CODE_MINUS;
  const bNegative = b.charCodeAt(0) === CODE_MINUS;
  if (aNegative !== bNegative) {
    if (isZeroText(a) && isZeroText(b)) return 0;
    return aNegative ? -1 : 1;
  }
  const order = compareMagnitude(a, aNegative ? 1 : 0, b, bNegative ? 1 : 0);
  return aNegative ? -order || 0 : order;
}

/** True if the value fits a column declared with this precision and scale. */
export function decFits(value: string, precision: number | undefined, scale: number | undefined): boolean {
  const body = value.charCodeAt(0) === CODE_MINUS ? value.slice(1) : value;
  const dot = body.indexOf('.');
  const integerDigits = (dot === -1 ? body : body.slice(0, dot)).replace(/^0+(?=\d)/, '');
  const fraction = dot === -1 ? '' : body.slice(dot + 1).replace(/0+$/, '');
  if (scale !== undefined && fraction.length > scale) return false;
  if (precision !== undefined) {
    const integerAllowed = precision - (scale ?? 0);
    const integerUsed = integerDigits === '0' ? 0 : integerDigits.length;
    if (integerUsed > integerAllowed) return false;
    if (scale === undefined && integerUsed + fraction.length > precision) return false;
  }
  return true;
}

/**
 * A running exact sum that gives the same text as `decSum` over the values added and not removed.
 * `decSum` shows the largest scale among its values, so this counts values per scale and keeps the
 * total at the largest scale seen. That total is always a whole multiple of the shown scale's unit,
 * so cutting it back to the shown scale loses nothing. Not exported from the package.
 */
export class DecimalSum {
  #total = 0n;
  /** The scale `#total` is held at. It only grows. */
  #scale = 0;
  /** How many values currently have each scale. */
  #perScale: number[] = [];
  #text: string | null = null;

  add(value: string): void {
    const x = toScaled(value);
    if (x.scale > this.#scale) {
      this.#total *= 10n ** BigInt(x.scale - this.#scale);
      this.#scale = x.scale;
    }
    this.#total += rescale(x, this.#scale);
    this.#perScale[x.scale] = (this.#perScale[x.scale] ?? 0) + 1;
    this.#text = null;
  }

  /** Takes back a value that was added, with the same text. */
  remove(value: string): void {
    const x = toScaled(value);
    const count = this.#perScale[x.scale] ?? 0;
    if (count === 0 || x.scale > this.#scale) throw new RangeError(`${JSON.stringify(value)} was never added`);
    this.#total -= rescale(x, this.#scale);
    this.#perScale[x.scale] = count - 1;
    this.#text = null;
  }

  toString(): string {
    if (this.#text !== null) return this.#text;
    let shown = 0;
    for (let s = this.#perScale.length - 1; s > 0; s--) {
      if ((this.#perScale[s] ?? 0) > 0) {
        shown = s;
        break;
      }
    }
    const total = shown === this.#scale ? this.#total : this.#total / 10n ** BigInt(this.#scale - shown);
    this.#text = fromScaled(total, shown);
    return this.#text;
  }
}
