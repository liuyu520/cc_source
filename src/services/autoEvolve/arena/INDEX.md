# `src/services/autoEvolve/arena/` 模块索引

## 模块定位

`arena/` 负责自演化过程中的“试验场”与运行编排，包括影子运行、谱系、晋升状态机、隔离区和 veto lesson 写回。

## 文件分组

### 控制与调度

- `arenaController.ts`
- `arenaScheduler.ts`
- `promotionFsm.ts`

### 影子运行链

- `shadowRunner.ts`
- `shadowRuntimeContext.ts`
- `shadowToolRuntime.ts`
- `shadowWorkerAdapter.ts`

### 谱系 / 关系 / 安全边界

- `lineageBuilder.ts`
- `kinshipIndex.ts`
- `forbiddenZones.ts`
- `sandboxFilter.ts`
- `quarantineTracker.ts`

### 安装与经验沉淀

- `kindInstaller.ts`
- `settingsHookInstaller.ts`
- `pendingHooksReader.ts`
- `vetoLessonWriter.ts`

## 关联模块

- 上级总览： [../INDEX.md](../INDEX.md)
- 评估与阈值： [../oracle/INDEX.md](../oracle/INDEX.md)
