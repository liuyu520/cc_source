# Context

用户希望优化需要用户确认的交互：当确认请求出现后，如果 2 分钟内没有收到用户回复，则自动按该确认框的默认选项执行，而不是一直阻塞等待。目标是尽可能复用现有确认弹窗、权限请求、Select 默认值与通知逻辑，避免逐个组件重复实现，并且不要误伤文本输入、编辑器、问答收集等非纯确认型场景。

当前代码显示：
- 权限确认统一入口在 `src/components/permissions/PermissionRequest.tsx`
- 权限框统一容器在 `src/components/permissions/PermissionDialog.tsx`
- 通用 setup dialog Promise 收口在 `src/interactiveHelpers.tsx`
- 现有仅有“超时通知”能力，没有“超时自动按默认项执行”能力，见 `src/hooks/useNotifyAfterTimeout.ts`
- `CustomSelect` 的“默认值”与“默认焦点”不是同一概念；单选实际提交跟焦点走，因此不能在基础 Select 层盲推默认动作

# Recommended approach

## 1. 把超时自动执行收敛到“确认请求调用方层”，不要下沉到 `CustomSelect`

在确认请求/权限请求这一层显式声明“超时默认结果”，不要试图从 `Select` 内部推导默认值。

原因：
- `src/components/CustomSelect/select.tsx`
- `src/components/CustomSelect/use-select-input.ts`
- `src/components/CustomSelect/use-select-navigation.ts`

这些文件表明单选里：
- `defaultValue` 是默认选中值
- `defaultFocusValue` 是默认焦点
- Enter 最终提交的是当前焦点项

因此“默认操作”应由业务调用方显式给出，最稳妥。

## 2. 在权限确认主链路新增一个可选的“自动按默认项完成”能力

优先在 `src/components/permissions/PermissionRequest.tsx` 这一层扩展，而不是改 `showDialog` / `showSetupDialog` 做全局兜底。

做法：
- 新增一个轻量 hook（建议放在 `src/hooks/`）用于处理：
  - 2 分钟倒计时
  - 用户一旦发生交互则停止自动执行
  - 到时后调用调用方提供的 `onTimeoutDefaultAction`
  - 组件卸载时清理 timer
- 在 `PermissionRequest.tsx` 中统一接入该 hook，但只在“当前 permission 子组件声明支持超时默认动作”时启用

这样可以最大化复用统一权限链路，同时避免把所有对话框一刀切超时化。

## 3. 由具体 PermissionRequest 子组件声明默认动作与是否启用

对每个纯确认型权限组件，补充一个明确的默认动作定义：
- 默认选哪一项
- 超时后执行什么回调（allow / reject / onDone + onReject 等）
- 是否需要展示倒计时提示

建议先覆盖这类纯确认型组件：
- `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx`
- `src/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx`
- 其他明确使用 `Select` 且无文本输入的权限请求组件

对于这类组件：
- 保证超时结果与 UI 默认焦点一致
- 若已有 `defaultFocusValue` / 默认选项，直接把同一值复用于 timeout result
- 不要从 `Select` 反推，而是在组件内定义一次，分别传给 Select 和 timeout action

## 4. 明确排除非纯确认场景，避免误提交

不要首批启用到以下场景：
- `src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx`
- 含文本输入/多问题收集/粘贴图片/外部编辑器的对话
- 安装向导、表单、长文本编辑、计划编辑等场景

这些场景不是“确认默认项”语义，超时自动提交风险高。

## 5. 在权限框标题区域展示轻量倒计时提示

复用 `src/components/permissions/PermissionDialog.tsx` 的 `titleRight` 区域显示剩余时间，例如：
- `2m defaulting to No`
- 或更简洁的剩余秒数/分钟提示

这样不需要改动主体布局，且与现有权限框结构一致。

## 6. 复用现有“超时通知”与“交互打断”思路

参考：
- `src/hooks/useNotifyAfterTimeout.ts`
- `src/hooks/useAwaySummary.ts`（来自探索结论）

复用其模式而不是复制代码：
- 打开确认框时启动计时器
- 用户有任何输入/选项导航/键盘操作时取消自动默认执行
- 保留现有通知逻辑，不和自动执行耦合混写

# Critical files to modify

核心接入：
- `src/components/permissions/PermissionRequest.tsx`
- `src/components/permissions/PermissionDialog.tsx`

新增/复用逻辑：
- `src/hooks/` 下新增一个确认超时 hook（文件名在实施时定）

首批适配的确认型权限组件（按实际确认后再缩放）：
- `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx`
- `src/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx`
- 其他纯选择型 permission request 组件

需要只读核对但不应直接下沉语义的基础组件：
- `src/components/CustomSelect/select.tsx`
- `src/components/CustomSelect/use-select-input.ts`
- `src/components/CustomSelect/use-select-navigation.ts`

# Reuse points

优先复用以下现有能力：
- 统一权限请求分发：`src/components/permissions/PermissionRequest.tsx`
- 权限框标题右侧插槽：`src/components/permissions/PermissionDialog.tsx`
- 超时提醒模式：`src/hooks/useNotifyAfterTimeout.ts`
- 定时器生命周期与 cleanup 模式：`src/hooks/useAwaySummary.ts`
- 通用 setup dialog Promise 收口（仅作参考，不作为主接入点）：`src/interactiveHelpers.tsx`

# Verification

实施后做真实验证，不用 mock：

1. 启动 CLI 进入会触发确认请求的真实路径
2. 构造至少一个纯确认型场景（如 plan mode 退出确认）
3. 确认弹窗出现后不做任何输入，等待超过 2 分钟：
   - 验证自动按默认选项执行
   - 验证执行结果与 UI 默认项一致
4. 再测一次：在 2 分钟内按方向键/Tab/输入进行交互
   - 验证自动默认执行被取消，不会误提交
5. 验证非纯确认型场景不受影响：
   - AskUserQuestion
   - 含文本输入或编辑器的对话
6. 验证倒计时提示展示正常，不破坏现有布局
7. 手动冒烟检查其他 permission request，确认未出现意外自动拒绝/自动通过
