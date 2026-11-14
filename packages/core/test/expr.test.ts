import { describe, expect, it } from 'vitest';
import { compileExpression, ExpressionError, isExpression, type AggregateName, type ExpressionScope } from '../src/index.ts';

type Data = Record<string, unknown>;

function makeScope(data: Data = {}, aggregates: Record<string, unknown> = {}) {
  const reads: string[] = [];
  const aggregated: string[] = [];
  const scope: ExpressionScope = {
    read(path) {
      reads.push(path.join('.'));
      return data[path.join('.')];
    },
    aggregate(name: AggregateName, path) {
      const key = `${name}(${path.join('.')})`;
      aggregated.push(key);
      return aggregates[key];
    },
  };
  return { scope, reads, aggregated };
}

function run(text: string, data: Data = {}, aggregates: Record<string, unknown> = {}): unknown {
  return compileExpression(text).evaluate(makeScope(data, aggregates).scope);
}

function compileError(text: string): ExpressionError {
  try {
    compileExpression(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ExpressionError);
    return error as ExpressionError;
  }
  throw new Error(`"${text}" compiled but should not have`);
}

function evalError(text: string, data: Data = {}): ExpressionError {
  const compiled = compileExpression(text);
  try {
    compiled.evaluate(makeScope(data).scope);
  } catch (error) {
    expect(error).toBeInstanceOf(ExpressionError);
    return error as ExpressionError;
  }
  throw new Error(`"${text}" evaluated but should not have`);
}

describe('isExpression', () => {
  it('is true only for strings starting with =', () => {
    expect(isExpression('=1')).toBe(true);
    expect(isExpression('1')).toBe(false);
    expect(isExpression(' =1')).toBe(false);
    expect(isExpression(5)).toBe(false);
    expect(isExpression(null)).toBe(false);
  });
});

describe('literals', () => {
  it('reads numbers, strings, booleans and null', () => {
    expect(run('=42')).toBe(42);
    expect(run('=1.25')).toBe(1.25);
    expect(run('="hi"')).toBe('hi');
    expect(run("='it\\'s'")).toBe("it's");
    expect(run('="a\\nb"')).toBe('a\nb');
    expect(run('=true')).toBe(true);
    expect(run('=false')).toBe(false);
    expect(run('=null')).toBe(null);
  });
});

describe('operators', () => {
  it('does number arithmetic', () => {
    expect(run('=2 + 3')).toBe(5);
    expect(run('=7 - 10')).toBe(-3);
    expect(run('=4 * 2.5')).toBe(10);
    expect(run('=9 / 2')).toBe(4.5);
    expect(run('=9 % 4')).toBe(1);
    expect(run('=-5')).toBe(-5);
    expect(run('=- -5')).toBe(5);
    expect(run('=!true')).toBe(false);
    expect(run('=!0')).toBe(true);
    expect(run('=!!"x"')).toBe(true);
  });

  it('follows precedence and associativity', () => {
    expect(run('=2 + 3 * 4')).toBe(14);
    expect(run('=(2 + 3) * 4')).toBe(20);
    expect(run('=10 - 4 - 3')).toBe(3);
    expect(run('=100 / 10 / 5')).toBe(2);
    expect(run('=-2 * 3')).toBe(-6);
    expect(run('=1 + 2 < 4')).toBe(true);
    expect(run('=1 < 2 == true')).toBe(true);
    expect(run('=true || false && false')).toBe(true);
    expect(run('=1 > 2 ? "a" : 3 > 2 ? "b" : "c"')).toBe('b');
    expect(run('=!false && true')).toBe(true);
  });

  it('compares numbers', () => {
    expect(run('=1 < 2')).toBe(true);
    expect(run('=2 <= 2')).toBe(true);
    expect(run('=3 > 4')).toBe(false);
    expect(run('=4 >= 4')).toBe(true);
    expect(run('=1 == 1')).toBe(true);
    expect(run('=1 != 1')).toBe(false);
    expect(run('="1" == 1')).toBe(false);
  });

  it('short-circuits and returns the deciding operand', () => {
    expect(run('="" || "fallback"')).toBe('fallback');
    expect(run('="a" || "b"')).toBe('a');
    expect(run('="a" && "b"')).toBe('b');
    expect(run('=0 && "b"')).toBe(0);
    const { scope, reads } = makeScope({ 'vars.x': 1, 'vars.y': 2 });
    compileExpression('=vars.x || vars.y').evaluate(scope);
    expect(reads).toEqual(['vars.x']);
    reads.length = 0;
    compileExpression('=false && vars.y').evaluate(scope);
    expect(reads).toEqual([]);
    // the unevaluated branch of ?: is not evaluated, so its error never happens
    expect(run('=true ? 1 : 1 / 0')).toBe(1);
    expect(run('=false && 1 / 0')).toBe(false);
  });

  it('evaluates ?: on truthiness', () => {
    expect(run('=vars.on ? "yes" : "no"', { 'vars.on': true })).toBe('yes');
    expect(run('=vars.on ? "yes" : "no"', { 'vars.on': 0 })).toBe('no');
    expect(run('=vars.on ? "yes" : "no"')).toBe('no');
  });
});

describe('nulls', () => {
  it('gives null for arithmetic with null or undefined', () => {
    expect(run('=null + 1')).toBe(null);
    expect(run('=1 - vars.missing')).toBe(null);
    expect(run('=vars.a * 2', { 'vars.a': null })).toBe(null);
    expect(run('=null / 2')).toBe(null);
    expect(run('=-vars.a', { 'vars.a': null })).toBe(null);
    expect(run('=ds.a.x + 1', { 'ds.a.x': null })).toBe(null);
  });

  it('compares null as false and equal to missing', () => {
    expect(run('=vars.a < 1', { 'vars.a': null })).toBe(false);
    expect(run('=vars.a >= 1', { 'vars.a': null })).toBe(false);
    expect(run('=vars.a == null', { 'vars.a': null })).toBe(true);
    expect(run('=vars.a == null')).toBe(true);
    expect(run('=vars.a != null', { 'vars.a': 1 })).toBe(true);
  });
});

describe('exact decimals', () => {
  it('adds decimal text exactly and returns text', () => {
    expect(run('=ds.a.x + 0.1', { 'ds.a.x': '0.2' })).toBe('0.3');
    expect(run('=ds.a.x + 0.1', { 'ds.a.x': '12345678901234567890.123456789' })).toBe('12345678901234567890.223456789');
    expect(run('=ds.a.x - 0.1', { 'ds.a.x': '12345678901234567890.1' })).toBe('12345678901234567890.0');
    expect(run('=0.1 + ds.a.x', { 'ds.a.x': '0.2' })).toBe('0.3');
  });

  it('multiplies and negates exactly', () => {
    expect(run('=ds.a.x * 3', { 'ds.a.x': '1234567890123456789.01' })).toBe('3703703670370370367.03');
    expect(run('=ds.a.x * ds.a.y', { 'ds.a.x': '1.10', 'ds.a.y': '2.5' })).toBe('2.750');
    expect(run('=-ds.a.x', { 'ds.a.x': '12.50' })).toBe('-12.50');
    expect(run('=-ds.a.x', { 'ds.a.x': '-12.50' })).toBe('12.50');
  });

  it('sends a number through String(n)', () => {
    expect(run('=ds.a.x + 1', { 'ds.a.x': '0.5' })).toBe('1.5');
    expect(run('=1.1 + ds.a.x', { 'ds.a.x': '0' })).toBe('1.1');
  });

  it('adds two decimal texts, and a decimal text with an integer-like text', () => {
    expect(run('=vars.a + vars.b', { 'vars.a': '1', 'vars.b': '2' })).toBe('3');
  });

  it('throws for a number that is not plain decimal text', () => {
    expect(evalError('=ds.a.x + vars.big', { 'ds.a.x': '1', 'vars.big': 1e21 }).message).toMatch(/Can't use "\+"/);
  });

  it('throws for other strings in arithmetic', () => {
    const e = evalError('="a" + "b"');
    expect(e.message).toMatch(/concat/);
    expect(e.position).toBe(5);
    expect(evalError('="a" - 1').message).toMatch(/Can't use/);
    expect(evalError('=vars.s * 2', { 'vars.s': 'abc' }).message).toMatch(/Can't use/);
    expect(evalError('=true + 1').message).toMatch(/Can't use/);
    expect(evalError('=-"abc"').message).toMatch(/negate/);
  });

  it('keeps / and % for numbers only', () => {
    expect(evalError('=ds.a.x / 2', { 'ds.a.x': '1.5' }).message).toMatch(/div\(/);
    expect(evalError('=ds.a.x % 2', { 'ds.a.x': '1.5' }).message).toMatch(/numbers only/);
    expect(evalError('=1 / 0').message).toMatch(/Division by zero/);
    expect(evalError('=1 % 0').message).toMatch(/zero/);
  });
});

describe('comparisons of text', () => {
  it('compares two decimal texts exactly', () => {
    expect(run('=vars.a < vars.b', { 'vars.a': '9', 'vars.b': '10' })).toBe(true);
    expect(run('=vars.a > vars.b', { 'vars.a': '9', 'vars.b': '10' })).toBe(false);
    expect(run('=vars.a >= vars.b', { 'vars.a': '1.50', 'vars.b': '1.5' })).toBe(true);
    expect(run('=vars.a <= vars.b', { 'vars.a': '-2', 'vars.b': '-10' })).toBe(false);
    expect(run('=vars.a < vars.b', { 'vars.a': '12345678901234567890.1', 'vars.b': '12345678901234567890.2' })).toBe(true);
  });

  it('compares other text ordinally', () => {
    expect(run('=vars.a < vars.b', { 'vars.a': '9a', 'vars.b': '10a' })).toBe(false);
    expect(run('="apple" < "banana"')).toBe(true);
    expect(run('="B" < "a"')).toBe(true);
    expect(run('=vars.a < vars.b', { 'vars.a': '2026-01-05', 'vars.b': '2026-01-10' })).toBe(true);
    expect(run('="9" < "10a"')).toBe(false);
  });

  it('compares a number with a decimal text exactly', () => {
    expect(run('=vars.a < 10', { 'vars.a': '9.99' })).toBe(true);
    expect(run('=vars.a >= 0.1', { 'vars.a': '0.10' })).toBe(true);
  });

  it('keeps == and != strict', () => {
    expect(run('=vars.a == vars.b', { 'vars.a': '1.50', 'vars.b': '1.5' })).toBe(false);
    expect(run('=vars.a != vars.b', { 'vars.a': '1.50', 'vars.b': '1.5' })).toBe(true);
    expect(run('=vars.a == "x"', { 'vars.a': 'x' })).toBe(true);
  });

  it('throws when two things cannot be compared', () => {
    expect(evalError('="a" < 1').message).toMatch(/Can't compare/);
    expect(evalError('=true < 1').message).toMatch(/Can't compare/);
  });
});

describe('functions', () => {
  it('concat joins text and turns null into empty text', () => {
    expect(run('=concat("a", 1, null, true, vars.x, "z")', { 'vars.x': 'X' })).toBe('a1trueXz');
    expect(run('=concat(vars.missing)')).toBe('');
  });

  it('round is exact', () => {
    expect(run('=round(ds.a.x, 2)', { 'ds.a.x': '2.675' })).toBe('2.68');
    expect(run('=round(ds.a.x, 0)', { 'ds.a.x': '-2.5' })).toBe('-3');
    expect(run('=round(ds.a.x, 3)', { 'ds.a.x': '1.5' })).toBe('1.500');
    expect(run('=round(3, 2)')).toBe('3.00');
    expect(run('=round(null, 2)')).toBe(null);
    expect(evalError('=round("abc", 2)').message).toMatch(/not a decimal/);
    expect(evalError('=round(1.5, -1)').message).toMatch(/scale/);
    expect(evalError('=round(1.5, 1.5)').message).toMatch(/scale/);
  });

  it('div is exact', () => {
    expect(run('=div(1, 3, 4)')).toBe('0.3333');
    expect(run('=div(ds.a.x, 3, 2)', { 'ds.a.x': '10.00' })).toBe('3.33');
    expect(run('=div(2, 3, 2)')).toBe('0.67');
    expect(run('=div(null, 3, 2)')).toBe(null);
    expect(evalError('=div(1, 0, 2)').message).toMatch(/Division by zero/);
    expect(evalError('=div(1, 0.00, 2)').message).toMatch(/Division by zero/);
  });

  it('aggregates go to scope.aggregate with an unevaluated path', () => {
    const { scope, aggregated, reads } = makeScope({}, { 'sum(ds.dsEmp.salary)': '300', 'count(salary)': 3 });
    expect(compileExpression('=sum(ds.dsEmp.salary) + 1').evaluate(scope)).toBe('301');
    expect(compileExpression('=count(salary)').evaluate(scope)).toBe(3);
    expect(aggregated).toEqual(['sum(ds.dsEmp.salary)', 'count(salary)']);
    expect(reads).toEqual([]);
    for (const name of ['sum', 'avg', 'min', 'max', 'count']) {
      const m = makeScope({}, { [`${name}(ds.a.b)`]: name });
      expect(compileExpression(`=${name}(ds.a.b)`).evaluate(m.scope)).toBe(name);
    }
  });
});

describe('paths', () => {
  it('reports each path once, in order, including aggregate paths', () => {
    const compiled = compileExpression('=vars.a + ds.dsEmp.$rowCount * vars.a + sum(ds.dsEmp.salary) + count(x) + (params.p ? 1 : 2)');
    expect(compiled.paths).toEqual([
      ['vars', 'a'],
      ['ds', 'dsEmp', '$rowCount'],
      ['ds', 'dsEmp', 'salary'],
      ['x'],
      ['params', 'p'],
    ]);
  });

  it('reads through scope.read with the segments', () => {
    const { scope, reads } = makeScope({ 'ds.dsEmp.$rowCount': 4, 'ds.dsEmp.$currentIndex': 1 });
    expect(compileExpression('=ds.dsEmp.$rowCount - ds.dsEmp.$currentIndex').evaluate(scope)).toBe(3);
    expect(reads).toEqual(['ds.dsEmp.$rowCount', 'ds.dsEmp.$currentIndex']);
  });

  it('has no paths for literals and does not treat keywords as paths', () => {
    expect(compileExpression('=true && null').paths).toEqual([]);
    expect(compileExpression('=vars.true').paths).toEqual([['vars', 'true']]);
  });

  it('only returns what scope.read returns, never prototype members', () => {
    const seen: (readonly string[])[] = [];
    const scope: ExpressionScope = {
      read: (path) => {
        seen.push(path);
        return undefined;
      },
      aggregate: () => undefined,
    };
    expect(compileExpression('=vars.constructor').evaluate(scope)).toBeUndefined();
    expect(compileExpression('=__proto__').evaluate(scope)).toBeUndefined();
    expect(compileExpression('=vars.__proto__.polluted').evaluate(scope)).toBeUndefined();
    expect(compileExpression('=constructor.constructor').evaluate(scope)).toBeUndefined();
    expect(seen).toEqual([['vars', 'constructor'], ['__proto__'], ['vars', '__proto__', 'polluted'], ['constructor', 'constructor']]);
    // calling anything outside the whitelist is a compile error
    expect(compileError('=constructor("return 1")()').message).toMatch(/Unknown function/);
    expect(compileError('=vars.toString()').message).toBeTruthy();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('compile errors', () => {
  it('reports positions', () => {
    expect(compileError('=1 +').position).toBe(4);
    expect(compileError('=1 + * 2').position).toBe(5);
    expect(compileError('=(1 + 2').position).toBe(7);
    expect(compileError('=1 2').position).toBe(3);
    expect(compileError('=1 # 2').position).toBe(3);
    expect(compileError('="abc').position).toBe(1);
    expect(compileError('=a = b').position).toBe(3);
    expect(compileError('=a & b').position).toBe(3);
    expect(compileError('=a ? b').position).toBe(6);
    expect(compileError('=a.').position).toBe(3);
    expect(compileError('=12abc').position).toBe(3);
    expect(compileError('=').position).toBe(1);
    expect(compileError('x').position).toBe(0);
  });

  it('rejects unknown functions with their position', () => {
    const error = compileError('=1 + foo(2)');
    expect(error.position).toBe(5);
    expect(error.message).toMatch(/Unknown function "foo"/);
    expect(error.source).toBe('=1 + foo(2)');
    expect(compileError('=eval("1")').message).toMatch(/Unknown function "eval"/);
    expect(compileError('=ds.x.sum(1)').message).toBeTruthy();
  });

  it('rejects bad call shapes', () => {
    expect(compileError('=sum(1)').message).toMatch(/column path/);
    expect(compileError('=sum(a, b)').message).toBeTruthy();
    expect(compileError('=sum()').message).toMatch(/column path/);
    expect(compileError('=round(1)').message).toMatch(/two arguments/);
    expect(compileError('=div(1, 2)').message).toMatch(/three arguments/);
    expect(compileError('=concat()').message).toMatch(/at least one/);
  });

  it('rejects [ ] member access and unsupported syntax', () => {
    expect(compileError('=ds.a[0]').message).toMatch(/not supported/);
    expect(compileError('=[1]').message).toMatch(/not supported/);
    expect(compileError('=a => 1').message).toBeTruthy();
    expect(compileError('=`x`').message).toBeTruthy();
  });

  it('bounds length and nesting', () => {
    expect(compileError('=' + '1+'.repeat(500) + '1').message).toMatch(/at most 1000/);
    expect(compileExpression('=' + '('.repeat(60) + '1' + ')'.repeat(60)).evaluate(makeScope().scope)).toBe(1);
    const deep = compileError('=' + '('.repeat(65) + '1' + ')'.repeat(65));
    expect(deep.message).toMatch(/nested/);
    expect(compileError('=' + '!'.repeat(70) + 'true').message).toMatch(/nested/);
    expect(compileError('=' + 'a?'.repeat(70) + 'b' + ':c'.repeat(70)).message).toMatch(/nested/);
    // a long flat chain is fine
    expect(compileExpression('=' + '1+'.repeat(300) + '1').evaluate(makeScope().scope)).toBe(301);
  });
});

describe('number literals keep their digits', () => {
  it('turns a literal a double cannot hold into exact decimal text', () => {
    expect(run('=ds.a.x + 12345678901234567.89', { 'ds.a.x': '0.01' })).toBe('12345678901234567.90');
    expect(run('=ds.a.x > 99999999999999999.98', { 'ds.a.x': '99999999999999999.99' })).toBe(true);
    expect(run('=ds.a.x > 99999999999999999.98', { 'ds.a.x': '99999999999999999.97' })).toBe(false);
    expect(run('=12345678901234567.89')).toBe('12345678901234567.89');
    expect(run('=1000000000000000000000')).toBe('1000000000000000000000');
  });

  it('leaves plain numbers as numbers', () => {
    expect(run('=0.1')).toBe(0.1);
    expect(run('=1.50')).toBe(1.5);
    expect(run('=100000000000000000000')).toBe(1e20);
    expect(run('=2 * 3')).toBe(6);
  });
});
