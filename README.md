# SWYP-Find Design Tokens

Figma Variables(DTCG W3C 표준)로 정의된 디자인 토큰을 [Style Dictionary v4](https://styledictionary.com/)로 변환해 iOS 산출물(Swift 상수 + Asset Catalog)을 생성하는 레포입니다.

## 전체 흐름

```
┌──────────────────────────┐
│  Figma Variables         │
│  (export → DTCG JSON)    │
└──────────────┬───────────┘
               │ Mode 1.tokens.json
               ▼
┌──────────────────────────┐
│  design-tokens repo      │  ← 이 레포
│  (Style Dictionary v4)   │
└──────────────┬───────────┘
               │ npm run build
               ▼
┌────────────────────────────────────────┐
│  build/ios/                            │
│  ├─ Colors.xcassets/                   │
│  │  ├─ Brand/      (primitive 색상)    │
│  │  ├─ Semantic/   (의미 색상)         │
│  │  └─ Component/  (컴포넌트 색상)     │
│  ├─ Colors+Brand.swift                 │
│  ├─ Colors+Semantic.swift              │
│  ├─ Colors+Component.swift             │
│  ├─ Component+Numbers.swift            │
│  ├─ Spacing+Generated.swift            │
│  └─ Radius+Generated.swift             │
└────────────────────────────────────────┘
```

## 토큰 레이어 구조

| 레이어 | DTCG 경로 | 용도 | 산출물 enum |
| --- | --- | --- | --- |
| Primitive (Brand) | `Colors.brand.<group>.<step>` | raw 색상 (Primary/Secondary/Beige/Neutral × 50–900) | `BrandColors` |
| Semantic | `Colors.semantic.<role>.<variant>` | 의미 색상 (text/border/surface/background/status) | `SemanticColors` |
| Component | `Component.<name>.<state>` | 컴포넌트별 색상 (button/input/badge) | `ComponentColors` |
| Spacing | `Spacing.<step>` | 간격 (0, 2, 4, …, 96) | `Spacing` |
| Radius | `Radius.<step>` | 모서리 반경 (none / default / full) | `Radius` |
| Component Number | `Component.<name>.<key>` (`$type=number`) | 컴포넌트 수치 (button.radius 등) | `ComponentNumbers` |

세 색상 레이어 모두 `Mode 1.tokens.json` 한 파일에서 자동으로 분리됩니다. 참조(`{Colors.brand.primary.500}`)는 Style Dictionary가 빌드 시점에 해석합니다.

## 로컬 빌드

요구 사항: Node.js 18+

```bash
npm install
npm run build       # → build/ios/
npm run clean       # 산출물 제거
npm run typecheck   # 타입 검증만
```

## 산출물 사용 (iOS)

생성된 파일을 SwiftPM/Xcode 모듈에 복사한 뒤:

```swift
import SwiftUI

struct PrimaryButton: View {
    var body: some View {
        Text("확인")
            .padding(.horizontal, Spacing.s16)
            .padding(.vertical, Spacing.s8)
            .background(ComponentColors.buttonPrimaryBackgroundDefault)
            .foregroundStyle(ComponentColors.buttonPrimaryTextDefault)
            .clipShape(RoundedRectangle(cornerRadius: Radius.default))
    }
}
```

> Asset Catalog는 `Brand/`, `Semantic/`, `Component/` 폴더 namespace를 사용합니다. Swift 코드는 `Color("Brand/Primary500", bundle: .module)` 형태로 자동 접근하므로 별도 설정이 필요 없습니다.

## 토큰 추가/수정 흐름

1. Figma에서 Variables 편집
2. `Mode 1.tokens.json`으로 export
3. `npm run build`
4. 산출물(`build/ios/`)을 iOS 프로젝트로 동기화

## 구현 메모

- **DTCG 포맷**: `$type` + `$value` 표준 사용. Style Dictionary v4의 `usesDtcg: true` 옵션으로 native 처리.
- **Figma 색상 객체 정규화**: Figma는 색상 값을 `{ colorSpace, components, alpha, hex }` 객체로 export합니다. 빌드 전 preprocessor가 `hex` 필드만 추출합니다.
- **참조 해석**: `Colors.semantic.text.primary → {Colors.brand.neutral.900}` 같은 alias는 Style Dictionary가 빌드 시 풀어줍니다.
- **Swift 예약어 회피**: `Radius.default` 같은 키는 `` `default` ``으로 자동 escape.
- **숫자 leaf 접두**: `Spacing.16` 같은 숫자 leaf는 Swift 식별자 규칙상 그대로 쓸 수 없으므로 `Spacing.s16`으로 변환.
