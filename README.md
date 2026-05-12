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
┌──────────────────────────────────┐
│  design-tokens repo (이 레포)    │
│                                  │
│  ① Style Dictionary v4 빌드      │  ← 1차 검증 (DTCG / alias)
│     → build/ios/ (artifact)      │
│                                  │
│  ② Picke-iOS checkout            │
│  ③ Tools/TokenGenerator.swift    │  ← 2차 검증 (실제 사용 Swift)
│  ④ 자동 PR (peter-evans/cpr)     │
└──────────────┬───────────────────┘
               │
               ▼
┌────────────────────────────────────────────────┐
│  SWYP-Find/Picke-iOS (develop)                 │
│  PR: chore/design-tokens-sync-<timestamp>      │
│                                                │
│  반영 경로:                                    │
│  Projects/Shared/DesignSystem/                 │
│  ├─ Resources/Mode 1.tokens.json               │
│  └─ Sources/                                   │
│     ├─ Color/ShapeStyle+.swift                 │
│     ├─ Extension/CGFloat/CGFloat+Radius+.swift │
│     ├─ Extension/CGFloat/CGFloat+Spacing+.swift│
│     └─ UI/Token/ComponentToken.swift           │
└────────────────────────────────────────────────┘
```

### Style Dictionary build/ios/ 산출물 (참고)

`Tools/TokenGenerator.swift` 가 iOS 측 코드젠을 담당하기 때문에, Style Dictionary 의 `build/ios/` 산출물 (`Colors+Brand.swift`, `Colors.xcassets/` 등) 은 **현재 iOS 앱에서 직접 사용하지 않습니다.** Style Dictionary 의 역할은:

- DTCG `$type` / alias 정합성 검증 (CI gate)
- 향후 Android / Web 등 추가 컨슈머 확장 시 재사용
- artifact 로 업로드되어 다운로드 가능

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
2. `Mode 1.tokens.json` 으로 export → 이 레포에 push
3. GitHub Actions 가 자동으로:
   - Style Dictionary 빌드 (1차 검증)
   - Picke-iOS checkout → `Tools/TokenGenerator.swift` 실행 (2차 검증)
   - Picke-iOS 의 `develop` 으로 자동 PR
4. iOS 팀이 PR review/merge

## CI 사전 준비

이 레포의 Settings → Secrets and variables → Actions 에 다음 시크릿을 등록:

| 이름 | 권한 | 용도 |
| --- | --- | --- |
| `IOS_REPO_PAT` | `SWYP-Find/Picke-iOS` 의 Contents: write + Pull requests: write | 자동 PR 생성 |

## 구현 메모

- **DTCG 포맷**: `$type` + `$value` 표준 사용. Style Dictionary v4의 `usesDtcg: true` 옵션으로 native 처리.
- **Figma 색상 객체 정규화**: Figma는 색상 값을 `{ colorSpace, components, alpha, hex }` 객체로 export합니다. 빌드 전 preprocessor가 `hex` 필드만 추출합니다.
- **참조 해석**: `Colors.semantic.text.primary → {Colors.brand.neutral.900}` 같은 alias는 Style Dictionary가 빌드 시 풀어줍니다.
- **Swift 예약어 회피**: `Radius.default` 같은 키는 `` `default` ``으로 자동 escape.
- **숫자 leaf 접두**: `Spacing.16` 같은 숫자 leaf는 Swift 식별자 규칙상 그대로 쓸 수 없으므로 `Spacing.s16`으로 변환.
