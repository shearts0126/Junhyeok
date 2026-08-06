import { ASTUtils, ESLintUtils, type TSESLint, type TSESTree } from '@typescript-eslint/utils';
import type * as ts from 'typescript';

/**
 * Decimal → number 변환 금지 (T0-4).
 *
 * 수량·금액을 JavaScript `number` 로 내리는 순간 IEEE754 double 의 정밀도로
 * 뭉개진다. 재고 원장은 불변이고 현재고는 원장의 합으로 계산되므로,
 * 한 번 들어간 오차는 모든 후속 잔고에 누적되며 정정거래로만 바로잡을 수 있다.
 *
 * ## 타입으로 판정한다
 *
 * 이 규칙은 **변수 이름을 보지 않는다.** `decimal` 이라는 이름을 확인하는
 * 방식은 변수명을 바꾸면 그대로 우회된다. 대신 TypeScript 타입 검사기로
 * 표현식의 타입이 Decimal 인지 판정한다. 따라서 다음이 모두 걸린다.
 *
 *   - 직접 생성값            `new Prisma.Decimal('1').toNumber()`
 *   - 함수 인자              `function f(qty: Decimal) { return +qty; }`
 *   - 객체 속성              `Number(line.quantity)`
 *   - 연산 결과              `a.plus(b).toNumber()`
 *   - 별칭 import            `import { Decimal as D } from '...'`
 *   - 이름을 바꾼 변수       `const x: Decimal = ...; x.toNumber()`
 *
 * 반대로 일반 문자열·number 에 대한 `Number('123')`, `parseFloat('1.25')`,
 * `parseInt('10', 10)` 은 허용된다.
 *
 * ## 허용되는 직렬화
 *
 * `decimal.toFixed()` 로 **문자열**을 얻는 것은 허용된다. 금지되는 것은 그
 * 문자열을 다시 number 로 되돌리는 `Number(d.toFixed())`, `parseFloat(d.toString())`
 * 같은 우회 경로다.
 *
 * @see src/shared/decimal/decimal.ts
 */

export type MessageIds = 'toNumberCall' | 'numberCoercion' | 'unaryPlus' | 'parseFromDecimal';

export interface RuleOptions {
  /**
   * Decimal 로 취급할 타입 이름.
   * 기본값 `['Decimal']` — Prisma 의 `Prisma.Decimal`(decimal.js) 이 이 이름이다.
   */
  readonly typeNames?: readonly string[];
}

export type Options = [RuleOptions?];

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/shearts0126/Junhyeok/blob/main/eslint-rules/${name}.ts`,
);

const DEFAULT_TYPE_NAMES: readonly string[] = ['Decimal'];

/**
 * Decimal 에서 문자열을 뽑는 메서드.
 *
 * 이 결과를 `Number()`/`parseFloat()` 에 넣는 것이 가장 흔한 우회 경로다.
 */
const STRINGIFYING_METHODS = new Set([
  'toString',
  'toFixed',
  'toJSON',
  'toPrecision',
  'toSignificantDigits',
  'valueOf',
]);

/** 재귀 깊이 상한. 상호 참조하는 타입에서 폭주를 막는다. */
const MAX_TYPE_DEPTH = 8;

function typeMatchesName(
  type: ts.Type,
  names: ReadonlySet<string>,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
  depth: number,
): boolean {
  if (depth > MAX_TYPE_DEPTH || seen.has(type)) return false;
  seen.add(type);

  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => typeMatchesName(member, names, checker, seen, depth + 1));
  }

  const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (symbolName !== undefined && names.has(symbolName)) return true;

  // `class Money extends Decimal` 같은 상속도 잡는다.
  if (type.isClassOrInterface()) {
    return checker
      .getBaseTypes(type)
      .some((base) => typeMatchesName(base, names, checker, seen, depth + 1));
  }

  return false;
}

export default createRule<Options, MessageIds>({
  name: 'no-decimal-to-number',
  meta: {
    type: 'problem',
    docs: {
      // ⚠️ 이 규칙은 타입 정보가 필요하다.
      //    적용하는 config 블록에 parserOptions.projectService 를 켜야 한다.
      description:
        'Decimal(수량·금액)을 JavaScript number 로 변환하지 못하게 한다. 정밀도가 소실된다.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          typeNames: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      toNumberCall:
        'Decimal 을 number 로 변환하면 정밀도가 소실됩니다. toNumber() 대신 Decimal 로 계산하고, 출력 경계에서는 toDecimalString() 으로 문자열화하세요.',
      numberCoercion:
        'Decimal 을 Number() 로 변환하면 정밀도가 소실됩니다. Decimal 을 그대로 두고, 출력 경계에서는 toDecimalString() 을 쓰세요.',
      unaryPlus:
        'Decimal 에 단항 + 를 쓰면 number 로 변환되어 정밀도가 소실됩니다. shared/decimal 의 연산 함수를 쓰세요.',
      parseFromDecimal:
        'Decimal 을 문자열로 바꾼 뒤 다시 숫자로 파싱하면 정밀도가 소실됩니다. 문자열은 출력용으로만 쓰고, 계산은 Decimal 로 하세요.',
    },
  },
  defaultOptions: [{ typeNames: DEFAULT_TYPE_NAMES }],

  create(context, [options]) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const typeNames = new Set(options?.typeNames ?? DEFAULT_TYPE_NAMES);

    /** 표현식의 타입이 Decimal 인가. */
    function isDecimalExpression(node: TSESTree.Node): boolean {
      const type = services.getTypeAtLocation(node);
      return typeMatchesName(type, typeNames, checker, new Set(), 0);
    }

    /** `d.toString()` / `d.toFixed(2)` 처럼 Decimal 에서 뽑은 문자열인가. */
    function isDecimalDerivedString(node: TSESTree.Node): boolean {
      if (node.type !== 'CallExpression') return false;
      const callee = node.callee;
      if (callee.type !== 'MemberExpression' || callee.computed) return false;
      if (callee.property.type !== 'Identifier') return false;
      if (!STRINGIFYING_METHODS.has(callee.property.name)) return false;
      return isDecimalExpression(callee.object);
    }

    /** Decimal 이거나 Decimal 에서 뽑은 문자열인가. */
    function isDecimalOrDerived(node: TSESTree.Node): boolean {
      return isDecimalExpression(node) || isDecimalDerivedString(node);
    }

    /**
     * 전역 함수를 가리키는 식별자인가.
     *
     * 지역에서 `Number` 를 새로 정의했다면 전역 Number 가 아니므로 보고하지 않는다.
     */
    function isGlobalCallee(node: TSESTree.Node, name: string): boolean {
      if (node.type !== 'Identifier' || node.name !== name) return false;
      const variable = ASTUtils.findVariable(context.sourceCode.getScope(node), name);
      return variable === null || variable.defs.length === 0;
    }

    function reportIfDecimalArgument(node: TSESTree.CallExpression, messageId: MessageIds): void {
      const [first] = node.arguments;
      if (first === undefined || first.type === 'SpreadElement') return;
      if (!isDecimalOrDerived(first)) return;
      context.report({ node, messageId });
    }

    return {
      CallExpression(node): void {
        // ① d.toNumber()
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'toNumber' &&
          isDecimalExpression(callee.object)
        ) {
          context.report({ node, messageId: 'toNumberCall' });
          return;
        }

        // ② Number(d) / Number(d.toString())
        if (isGlobalCallee(callee, 'Number')) {
          reportIfDecimalArgument(node, 'numberCoercion');
          return;
        }

        // ③ parseFloat(d.toString()) / parseInt(d.toString(), 10)
        if (isGlobalCallee(callee, 'parseFloat') || isGlobalCallee(callee, 'parseInt')) {
          reportIfDecimalArgument(node, 'parseFromDecimal');
        }
      },

      // ④ +d
      UnaryExpression(node): void {
        if (node.operator !== '+') return;
        if (!isDecimalExpression(node.argument)) return;
        context.report({ node, messageId: 'unaryPlus' });
      },
    };
  },
}) satisfies TSESLint.RuleModule<MessageIds, Options>;
