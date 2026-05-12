import fs from 'node:fs';
import path from 'node:path';
import StyleDictionary from 'style-dictionary';
import type {
  Config,
  DesignTokens,
  TransformedToken,
} from 'style-dictionary/types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Load Figma Variables (DTCG) tokens
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_FILE = 'Mode 1.tokens.json';

type DtcgNode = {
  $type?: string;
  $value?: unknown;
  $extensions?: unknown;
  [key: string]: unknown;
};

type FigmaColorValue = {
  colorSpace?: string;
  components?: number[];
  alpha?: number;
  hex?: string;
};

const rawTokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')) as Record<
  string,
  unknown
>;

// Figma Variables exports color values as an object containing `hex`.
// Style Dictionary expects a string value for `$type=color`, so we collapse
// the object down to its hex form and drop `$extensions` noise.
function normalizeFigmaDtcg(node: unknown): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const dict = node as DtcgNode;
  if ('$type' in dict && '$value' in dict) {
    if (
      dict.$type === 'color' &&
      typeof dict.$value === 'object' &&
      dict.$value !== null &&
      typeof (dict.$value as FigmaColorValue).hex === 'string'
    ) {
      dict.$value = (dict.$value as FigmaColorValue).hex!;
    }
    delete dict.$extensions;
    return;
  }
  for (const key of Object.keys(dict)) {
    normalizeFigmaDtcg(dict[key]);
  }
}
normalizeFigmaDtcg(rawTokens);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Naming helpers
// ─────────────────────────────────────────────────────────────────────────────

function pascalCase(segment: string): string {
  return segment
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

const SWIFT_RESERVED = new Set([
  'default',
  'class',
  'case',
  'enum',
  'func',
  'let',
  'var',
  'return',
  'if',
  'else',
  'switch',
  'for',
  'while',
  'do',
  'break',
  'continue',
  'import',
  'public',
  'private',
  'internal',
  'protocol',
  'struct',
  'extension',
  'init',
  'self',
  'true',
  'false',
  'nil',
]);

function safeSwiftIdent(name: string): string {
  if (SWIFT_RESERVED.has(name)) return `\`${name}\``;
  if (/^[0-9]/.test(name)) return `_${name}`;
  return name;
}

// Path segments to strip when generating Swift property names.
// The enclosing Swift enum (BrandColors, Spacing, ...) already scopes the name,
// so the layer prefix is redundant inside it.
const SWIFT_PREFIX_TO_STRIP: Array<string[]> = [
  ['Colors', 'brand'],
  ['Colors', 'semantic'],
  ['Component'],
  ['Spacing'],
  ['Radius'],
];

function stripSwiftPrefix(tokenPath: string[]): string[] {
  for (const prefix of SWIFT_PREFIX_TO_STRIP) {
    if (prefix.every((seg, i) => tokenPath[i] === seg)) {
      return tokenPath.slice(prefix.length);
    }
  }
  return tokenPath;
}

// xcassets namespace folder ("Brand" / "Semantic" / "Component") for grouping.
function xcassetsNamespace(tokenPath: string[]): string | null {
  if (tokenPath[0] === 'Colors' && tokenPath[1] === 'brand') return 'Brand';
  if (tokenPath[0] === 'Colors' && tokenPath[1] === 'semantic')
    return 'Semantic';
  if (tokenPath[0] === 'Component') return 'Component';
  return null;
}

// Asset name *within* its xcassets namespace folder.
// e.g. Colors.brand.primary.500 → "Primary500"  (folder: Brand)
//      Component.button.primary.background.default → "ButtonPrimaryBackgroundDefault"
function colorsetLeafName(tokenPath: string[]): string {
  return stripSwiftPrefix(tokenPath).map(pascalCase).join('');
}

// Full asset string used by `Color("...", bundle:)` — includes the namespace
// folder so Xcode resolves it through `provides-namespace`.
function colorsetAccessString(tokenPath: string[]): string {
  const ns = xcassetsNamespace(tokenPath);
  const leaf = colorsetLeafName(tokenPath);
  return ns ? `${ns}/${leaf}` : leaf;
}

// Swift property name (camelCase). Numerics get an `s` prefix so `Spacing.16`
// becomes `Spacing.s16` instead of an invalid `Spacing.16` (or ugly `_16`).
function swiftPropertyName(tokenPath: string[]): string {
  const stripped = stripSwiftPrefix(tokenPath);
  if (stripped.length === 0) return safeSwiftIdent(pascalCase(tokenPath[0]));
  const joined = stripped.map(pascalCase).join('');
  let camel = joined.charAt(0).toLowerCase() + joined.slice(1);
  if (/^[0-9]/.test(camel)) camel = `s${camel}`;
  return safeSwiftIdent(camel);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Token filters (by DTCG path + $type)
// ─────────────────────────────────────────────────────────────────────────────

function tokenType(token: TransformedToken): string | undefined {
  const t = token as TransformedToken & { $type?: string; type?: string };
  return t.$type ?? t.type;
}

const isBrandColor = (t: TransformedToken) =>
  t.path[0] === 'Colors' && t.path[1] === 'brand' && tokenType(t) === 'color';

const isSemanticColor = (t: TransformedToken) =>
  t.path[0] === 'Colors' &&
  t.path[1] === 'semantic' &&
  tokenType(t) === 'color';

const isComponentColor = (t: TransformedToken) =>
  t.path[0] === 'Component' && tokenType(t) === 'color';

const isComponentNumber = (t: TransformedToken) =>
  t.path[0] === 'Component' && tokenType(t) === 'number';

const isSpacing = (t: TransformedToken) => t.path[0] === 'Spacing';
const isRadius = (t: TransformedToken) => t.path[0] === 'Radius';

// ─────────────────────────────────────────────────────────────────────────────
// 4. Hex → xcassets components
// ─────────────────────────────────────────────────────────────────────────────

function hexToComponents(hex: string, tokenPath: string[]): {
  red: string;
  green: string;
  blue: string;
  alpha: string;
} {
  const h = String(hex).trim().replace(/^#/, '');
  let r: string;
  let g: string;
  let b: string;
  let a: string;
  if (h.length === 6) {
    [r, g, b, a] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6), 'FF'];
  } else if (h.length === 8) {
    [r, g, b, a] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6), h.slice(6, 8)];
  } else if (h.length === 3) {
    [r, g, b, a] = [h[0] + h[0], h[1] + h[1], h[2] + h[2], 'FF'];
  } else {
    throw new Error(
      `Invalid hex color "${hex}" at token "${tokenPath.join('.')}"`,
    );
  }
  const alphaFloat = (parseInt(a, 16) / 255).toFixed(3);
  return {
    red: `0x${r.toUpperCase()}`,
    green: `0x${g.toUpperCase()}`,
    blue: `0x${b.toUpperCase()}`,
    alpha: alphaFloat,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. xcassets action — emits one .colorset per color token
// ─────────────────────────────────────────────────────────────────────────────

function writeAssetCatalogContents(dir: string, providesNamespace: boolean) {
  const body: Record<string, unknown> = {
    info: { author: 'xcode', version: 1 },
  };
  if (providesNamespace) {
    body.properties = { 'provides-namespace': true };
  }
  fs.writeFileSync(
    path.join(dir, 'Contents.json'),
    JSON.stringify(body, null, 2) + '\n',
  );
}

StyleDictionary.registerAction({
  name: 'ios/xcassets',
  do: (dictionary, platform) => {
    const buildPath = String(platform.buildPath ?? '');
    const xcassetsDir = path.join(buildPath, 'Colors.xcassets');
    fs.mkdirSync(xcassetsDir, { recursive: true });
    writeAssetCatalogContents(xcassetsDir, false);

    const namespacesSeen = new Set<string>();
    let written = 0;
    for (const token of dictionary.allTokens) {
      if (tokenType(token) !== 'color') continue;
      const hex = String(
        (token as TransformedToken & { $value?: unknown }).$value ??
          token.value,
      );
      const ns = xcassetsNamespace(token.path);
      const leaf = colorsetLeafName(token.path);
      const parentDir = ns ? path.join(xcassetsDir, ns) : xcassetsDir;
      if (ns && !namespacesSeen.has(ns)) {
        fs.mkdirSync(parentDir, { recursive: true });
        writeAssetCatalogContents(parentDir, true);
        namespacesSeen.add(ns);
      }
      const colorsetDir = path.join(parentDir, `${leaf}.colorset`);
      fs.mkdirSync(colorsetDir, { recursive: true });
      const components = hexToComponents(hex, token.path);
      const colorset = {
        info: { author: 'xcode', version: 1 },
        colors: [
          {
            idiom: 'universal',
            color: { 'color-space': 'srgb', components },
          },
        ],
      };
      fs.writeFileSync(
        path.join(colorsetDir, 'Contents.json'),
        JSON.stringify(colorset, null, 2) + '\n',
      );
      written++;
    }
    console.log(`  ✔ Wrote ${written} colorsets → ${xcassetsDir}`);
  },
  undo: (_dictionary, platform) => {
    const buildPath = String(platform.buildPath ?? '');
    const xcassetsDir = path.join(buildPath, 'Colors.xcassets');
    if (fs.existsSync(xcassetsDir)) {
      fs.rmSync(xcassetsDir, { recursive: true, force: true });
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Swift formats
// ─────────────────────────────────────────────────────────────────────────────

const SWIFT_HEADER = '// Auto-generated by Style Dictionary. Do not edit.';

function emitSwiftColorEnum(
  enumName: string,
  tokens: TransformedToken[],
): string {
  const lines = [
    SWIFT_HEADER,
    'import SwiftUI',
    '',
    `public enum ${enumName} {`,
  ];
  for (const t of tokens) {
    const prop = swiftPropertyName(t.path);
    const asset = colorsetAccessString(t.path);
    lines.push(
      `    public static let ${prop} = Color("${asset}", bundle: .module)`,
    );
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function emitSwiftNumberEnum(
  enumName: string,
  tokens: TransformedToken[],
): string {
  const lines = [
    SWIFT_HEADER,
    'import CoreGraphics',
    '',
    `public enum ${enumName} {`,
  ];
  for (const t of tokens) {
    const prop = swiftPropertyName(t.path);
    const raw =
      (t as TransformedToken & { $value?: unknown }).$value ?? t.value;
    const num = Number(raw);
    if (Number.isNaN(num)) {
      throw new Error(
        `Non-numeric value for ${t.path.join('.')}: ${String(raw)}`,
      );
    }
    lines.push(`    public static let ${prop}: CGFloat = ${num}`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

StyleDictionary.registerFormat({
  name: 'swift/brand-colors',
  format: ({ dictionary }) =>
    emitSwiftColorEnum(
      'BrandColors',
      dictionary.allTokens.filter(isBrandColor),
    ),
});
StyleDictionary.registerFormat({
  name: 'swift/semantic-colors',
  format: ({ dictionary }) =>
    emitSwiftColorEnum(
      'SemanticColors',
      dictionary.allTokens.filter(isSemanticColor),
    ),
});
StyleDictionary.registerFormat({
  name: 'swift/component-colors',
  format: ({ dictionary }) =>
    emitSwiftColorEnum(
      'ComponentColors',
      dictionary.allTokens.filter(isComponentColor),
    ),
});
StyleDictionary.registerFormat({
  name: 'swift/component-numbers',
  format: ({ dictionary }) =>
    emitSwiftNumberEnum(
      'ComponentNumbers',
      dictionary.allTokens.filter(isComponentNumber),
    ),
});
StyleDictionary.registerFormat({
  name: 'swift/spacing',
  format: ({ dictionary }) =>
    emitSwiftNumberEnum('Spacing', dictionary.allTokens.filter(isSpacing)),
});
StyleDictionary.registerFormat({
  name: 'swift/radius',
  format: ({ dictionary }) =>
    emitSwiftNumberEnum('Radius', dictionary.allTokens.filter(isRadius)),
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Config — single iOS platform, DTCG mode on, references resolved
// ─────────────────────────────────────────────────────────────────────────────

// Style Dictionary's default token name is the leaf path segment, which
// collides for tokens like Colors.brand.primary.500 vs Colors.brand.secondary.500.
// Joining the full path yields globally unique names and silences the warning.
StyleDictionary.registerTransform({
  name: 'name/joined',
  type: 'name',
  transform: (token) => token.path.join('_'),
});

export const config: Config = {
  log: { warnings: 'warn', verbosity: 'default' },
  usesDtcg: true,
  tokens: rawTokens as unknown as DesignTokens,
  platforms: {
    ios: {
      buildPath: 'build/ios/',
      transforms: ['name/joined'],
      actions: ['ios/xcassets'],
      files: [
        {
          destination: 'Colors+Brand.swift',
          format: 'swift/brand-colors',
        },
        {
          destination: 'Colors+Semantic.swift',
          format: 'swift/semantic-colors',
        },
        {
          destination: 'Colors+Component.swift',
          format: 'swift/component-colors',
        },
        {
          destination: 'Component+Numbers.swift',
          format: 'swift/component-numbers',
        },
        {
          destination: 'Spacing+Generated.swift',
          format: 'swift/spacing',
        },
        {
          destination: 'Radius+Generated.swift',
          format: 'swift/radius',
        },
      ],
    },
  },
};
