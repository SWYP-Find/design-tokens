import fs from 'node:fs';
import path from 'node:path';
import StyleDictionary from 'style-dictionary';
import type { Config, TransformedToken } from 'style-dictionary/types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Source files (Tokens Studio DTCG split export)
// ─────────────────────────────────────────────────────────────────────────────
// Style Dictionary deep-merges these into a single tree. Bare references like
// `{primary.500}` resolve against the merged result, so the order here only
// matters for collision overwriting (which we don't rely on).
const SOURCE_FILES = ['primitive.json', 'semantic.json', 'component.json'];

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
  'default', 'class', 'case', 'enum', 'func', 'let', 'var', 'return', 'if', 'else',
  'switch', 'for', 'while', 'do', 'break', 'continue', 'import', 'public', 'private',
  'internal', 'protocol', 'struct', 'extension', 'init', 'self', 'true', 'false', 'nil',
]);

function safeSwiftIdent(name: string): string {
  if (SWIFT_RESERVED.has(name)) return `\`${name}\``;
  if (/^[0-9]/.test(name)) return `_${name}`;
  return name;
}

const KOTLIN_RESERVED = new Set([
  'class', 'object', 'interface', 'package', 'import', 'fun', 'val', 'var', 'if', 'else',
  'when', 'for', 'while', 'return', 'true', 'false', 'null', 'this', 'super', 'in', 'is',
  'as', 'try', 'catch', 'throw', 'typealias', 'typeof',
]);

function safeKotlinIdent(name: string): string {
  if (KOTLIN_RESERVED.has(name)) return `\`${name}\``;
  if (/^[0-9]/.test(name)) return `_${name}`;
  return name;
}

/**
 * camelCase property name for a token path. Handles three special-case primitive
 * keys whose dashes encode a tier prefix we want to strip/transform:
 *   spacing-N / spscing-N (typo)  → s<N>
 *   radius-default / radius-max   → default / max
 *   border-width-X                → borderWidthX
 * All other paths get straight camelCase concatenation.
 */
function propertyNameRaw(tokenPath: string[]): string {
  if (tokenPath.length === 1) {
    const seg = tokenPath[0];
    const spacingMatch = seg.match(/^sp[sa]cing-(\d+)$/);
    if (spacingMatch) return `s${spacingMatch[1]}`;
    const radiusMatch = seg.match(/^radius-(.+)$/);
    if (radiusMatch) return radiusMatch[1];
    const borderWidthMatch = seg.match(/^border-width-(.+)$/);
    if (borderWidthMatch) return `borderWidth${pascalCase(borderWidthMatch[1])}`;
  }
  const joined = tokenPath.map(pascalCase).join('');
  let camel = joined.charAt(0).toLowerCase() + joined.slice(1);
  if (/^[0-9]/.test(camel)) camel = `s${camel}`;
  return camel;
}

function swiftPropertyName(tokenPath: string[]): string {
  return safeSwiftIdent(propertyNameRaw(tokenPath));
}

function kotlinPropertyName(tokenPath: string[]): string {
  return safeKotlinIdent(propertyNameRaw(tokenPath));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Token bucketing — derived from the new flat schema
// ─────────────────────────────────────────────────────────────────────────────

const BRAND_GROUPS = new Set(['primary', 'secondary', 'beige', 'gray']);
const BRAND_SCALES = new Set([
  '50', '100', '200', '300', '400', '500', '600', '700', '800', '900',
]);
const STATUS_GROUPS = new Set(['error', 'warning']);
const SEMANTIC_ROOTS = new Set([
  'background', 'text', 'border', 'surface', 'action', 'icon',
]);
const COMPONENT_ROOTS = new Set([
  'button', 'badge', 'chip', 'toggle', 'card', 'input', 'navigation',
  'popup', 'thumbnail', 'listItem', 'checkbox', 'avatar',
]);
const NUMERIC_TYPES = new Set([
  'sizing', 'spacing', 'borderRadius', 'borderWidth', 'number',
]);
const PRIMITIVE_SIZING_ROOTS = new Set(['icon', 'avatar', 'control']);

function tokenType(token: TransformedToken): string | undefined {
  const t = token as TransformedToken & { $type?: string; type?: string };
  return t.$type ?? t.type;
}

const isBrandColor = (t: TransformedToken) =>
  BRAND_GROUPS.has(t.path[0]) && BRAND_SCALES.has(t.path[1]) && tokenType(t) === 'color';

const isStatusColor = (t: TransformedToken) =>
  STATUS_GROUPS.has(t.path[0]) && t.path.length === 2 && tokenType(t) === 'color';

const isSemanticColor = (t: TransformedToken) =>
  SEMANTIC_ROOTS.has(t.path[0]) && tokenType(t) === 'color';

const isComponentColor = (t: TransformedToken) =>
  COMPONENT_ROOTS.has(t.path[0]) && tokenType(t) === 'color';

const isPrimitiveSizing = (t: TransformedToken) =>
  PRIMITIVE_SIZING_ROOTS.has(t.path[0]) && tokenType(t) === 'sizing';

const isBorderWidth = (t: TransformedToken) =>
  t.path.length === 1 && t.path[0].startsWith('border-width-');

const isComponentNumber = (t: TransformedToken) => {
  if (!NUMERIC_TYPES.has(tokenType(t) ?? '')) return false;
  const root = t.path[0];
  if (COMPONENT_ROOTS.has(root)) return true;
  if (root === 'padding' || root === 'gap') return true;
  if (isPrimitiveSizing(t)) return true;
  if (isBorderWidth(t)) return true;
  return false;
};

const isSpacing = (t: TransformedToken) =>
  t.path.length === 1 && /^sp[sa]cing-\d+$/.test(t.path[0]);

const isRadius = (t: TransformedToken) =>
  t.path.length === 1 && /^radius-/.test(t.path[0]);

// ─────────────────────────────────────────────────────────────────────────────
// 4. xcassets namespacing
// ─────────────────────────────────────────────────────────────────────────────

function xcassetsNamespace(tokenPath: string[]): string | null {
  const root = tokenPath[0];
  if (BRAND_GROUPS.has(root)) return 'Brand';
  if (STATUS_GROUPS.has(root) && tokenPath.length === 2) return 'Status';
  if (SEMANTIC_ROOTS.has(root)) return 'Semantic';
  if (COMPONENT_ROOTS.has(root)) return 'Component';
  return null;
}

function colorsetLeafName(tokenPath: string[]): string {
  const raw = propertyNameRaw(tokenPath);
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function colorsetAccessString(tokenPath: string[]): string {
  const ns = xcassetsNamespace(tokenPath);
  const leaf = colorsetLeafName(tokenPath);
  return ns ? `${ns}/${leaf}` : leaf;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Color value parsing (hex + rgba)
// ─────────────────────────────────────────────────────────────────────────────

function parseRgba(s: string): { r: number; g: number; b: number; a: number } | null {
  if (!s.startsWith('rgba(') || !s.endsWith(')')) return null;
  const parts = s.slice(5, -1).split(',').map((p) => p.trim());
  if (parts.length !== 4) return null;
  const r = parseInt(parts[0], 10);
  const g = parseInt(parts[1], 10);
  const b = parseInt(parts[2], 10);
  const a = parseFloat(parts[3]);
  if ([r, g, b].some((n) => Number.isNaN(n)) || Number.isNaN(a)) return null;
  return { r, g, b, a };
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

function colorToXcassetsComponents(value: string, tokenPath: string[]): {
  red: string; green: string; blue: string; alpha: string;
} {
  const v = String(value).trim();
  const rgba = parseRgba(v);
  if (rgba) {
    return {
      red: `0x${hex2(rgba.r)}`,
      green: `0x${hex2(rgba.g)}`,
      blue: `0x${hex2(rgba.b)}`,
      alpha: rgba.a.toFixed(3),
    };
  }
  const h = v.replace(/^#/, '');
  let r: string, g: string, b: string, a: string;
  if (h.length === 6) {
    [r, g, b, a] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6), 'FF'];
  } else if (h.length === 8) {
    [r, g, b, a] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6), h.slice(6, 8)];
  } else if (h.length === 3) {
    [r, g, b, a] = [h[0] + h[0], h[1] + h[1], h[2] + h[2], 'FF'];
  } else {
    throw new Error(`Invalid color "${value}" at token "${tokenPath.join('.')}"`);
  }
  return {
    red: `0x${r.toUpperCase()}`,
    green: `0x${g.toUpperCase()}`,
    blue: `0x${b.toUpperCase()}`,
    alpha: (parseInt(a, 16) / 255).toFixed(3),
  };
}

function colorToComposeArgb(value: string, tokenPath: string[]): string {
  const v = String(value).trim();
  const rgba = parseRgba(v);
  if (rgba) {
    return `0x${hex2(Math.round(rgba.a * 255))}${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}`;
  }
  const h = v.replace(/^#/, '').toUpperCase();
  let r: string, g: string, b: string, a: string;
  if (h.length === 6) {
    [r, g, b, a] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6), 'FF'];
  } else if (h.length === 8) {
    [r, g, b, a] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6), h.slice(6, 8)];
  } else if (h.length === 3) {
    [r, g, b, a] = [h[0] + h[0], h[1] + h[1], h[2] + h[2], 'FF'];
  } else {
    throw new Error(`Invalid color "${value}" at token "${tokenPath.join('.')}"`);
  }
  return `0x${a}${r}${g}${b}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. xcassets action — emits one .colorset per color token
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
      const value = String(
        (token as TransformedToken & { $value?: unknown }).$value ?? token.value,
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
      const components = colorToXcassetsComponents(value, token.path);
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
// 7. Swift formats
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
  format: ({ dictionary }) => {
    const tokens = [
      ...dictionary.allTokens.filter(isBrandColor),
      ...dictionary.allTokens.filter(isStatusColor),
    ];
    return emitSwiftColorEnum('BrandColors', tokens);
  },
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
// 8. Kotlin (Jetpack Compose) formats
// ─────────────────────────────────────────────────────────────────────────────

const KOTLIN_PACKAGE = 'com.picke.app.ui.theme.tokens';
const KOTLIN_HEADER = `// Auto-generated by Style Dictionary. Do not edit.
package ${KOTLIN_PACKAGE}`;

function emitKotlinColorObject(
  objectName: string,
  tokens: TransformedToken[],
): string {
  const lines = [
    KOTLIN_HEADER,
    '',
    'import androidx.compose.ui.graphics.Color',
    '',
    `object ${objectName} {`,
  ];
  for (const t of tokens) {
    const prop = kotlinPropertyName(t.path);
    const value = String(
      (t as TransformedToken & { $value?: unknown }).$value ?? t.value,
    );
    const argb = colorToComposeArgb(value, t.path);
    lines.push(`    val ${prop}: Color = Color(${argb})`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function emitKotlinDpObject(
  objectName: string,
  tokens: TransformedToken[],
): string {
  const lines = [
    KOTLIN_HEADER,
    '',
    'import androidx.compose.ui.unit.Dp',
    'import androidx.compose.ui.unit.dp',
    '',
    `object ${objectName} {`,
  ];
  for (const t of tokens) {
    const prop = kotlinPropertyName(t.path);
    const raw =
      (t as TransformedToken & { $value?: unknown }).$value ?? t.value;
    const num = Number(raw);
    if (Number.isNaN(num)) {
      throw new Error(
        `Non-numeric value for ${t.path.join('.')}: ${String(raw)}`,
      );
    }
    lines.push(`    val ${prop}: Dp = ${num}.dp`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

StyleDictionary.registerFormat({
  name: 'kotlin/brand-colors',
  format: ({ dictionary }) => {
    const tokens = [
      ...dictionary.allTokens.filter(isBrandColor),
      ...dictionary.allTokens.filter(isStatusColor),
    ];
    return emitKotlinColorObject('BrandColorTokens', tokens);
  },
});
StyleDictionary.registerFormat({
  name: 'kotlin/semantic-colors',
  format: ({ dictionary }) =>
    emitKotlinColorObject(
      'SemanticColorTokens',
      dictionary.allTokens.filter(isSemanticColor),
    ),
});
StyleDictionary.registerFormat({
  name: 'kotlin/component-colors',
  format: ({ dictionary }) =>
    emitKotlinColorObject(
      'ComponentColorTokens',
      dictionary.allTokens.filter(isComponentColor),
    ),
});
StyleDictionary.registerFormat({
  name: 'kotlin/component-numbers',
  format: ({ dictionary }) =>
    emitKotlinDpObject(
      'ComponentNumberTokens',
      dictionary.allTokens.filter(isComponentNumber),
    ),
});
StyleDictionary.registerFormat({
  name: 'kotlin/spacing',
  format: ({ dictionary }) =>
    emitKotlinDpObject(
      'SpacingTokens',
      dictionary.allTokens.filter(isSpacing),
    ),
});
StyleDictionary.registerFormat({
  name: 'kotlin/radius',
  format: ({ dictionary }) =>
    emitKotlinDpObject('RadiusTokens', dictionary.allTokens.filter(isRadius)),
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Config
// ─────────────────────────────────────────────────────────────────────────────
// Globally unique token names. Default name = leaf segment collides for
// duplicated leaves (e.g. multiple `.default`/`.500`), so we join the full path.
StyleDictionary.registerTransform({
  name: 'name/joined',
  type: 'name',
  transform: (token) => token.path.join('_'),
});

export const config: Config = {
  log: { warnings: 'warn', verbosity: 'default' },
  usesDtcg: true,
  source: SOURCE_FILES,
  platforms: {
    ios: {
      buildPath: 'build/ios/',
      transforms: ['name/joined'],
      actions: ['ios/xcassets'],
      files: [
        { destination: 'Colors+Brand.swift', format: 'swift/brand-colors' },
        { destination: 'Colors+Semantic.swift', format: 'swift/semantic-colors' },
        { destination: 'Colors+Component.swift', format: 'swift/component-colors' },
        { destination: 'Component+Numbers.swift', format: 'swift/component-numbers' },
        { destination: 'Spacing+Generated.swift', format: 'swift/spacing' },
        { destination: 'Radius+Generated.swift', format: 'swift/radius' },
      ],
    },
    android: {
      buildPath: 'build/android/',
      transforms: ['name/joined'],
      files: [
        { destination: 'BrandColorTokens.kt', format: 'kotlin/brand-colors' },
        { destination: 'SemanticColorTokens.kt', format: 'kotlin/semantic-colors' },
        { destination: 'ComponentColorTokens.kt', format: 'kotlin/component-colors' },
        { destination: 'ComponentNumberTokens.kt', format: 'kotlin/component-numbers' },
        { destination: 'SpacingTokens.kt', format: 'kotlin/spacing' },
        { destination: 'RadiusTokens.kt', format: 'kotlin/radius' },
      ],
    },
  },
};
