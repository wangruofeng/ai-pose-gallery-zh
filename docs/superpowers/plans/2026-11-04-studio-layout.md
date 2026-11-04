# 合成台布局与接口耗时实施计划

1. 调整 `src/routes/studio.tsx`：将四个模块改为两排双列网格，移动未决任务到整行，保持手机端单列。
2. 在 `src/services/aiGenerator.ts` 增加请求开始回调，在 `src/store/studioStore.tsx` 记录开始与结束时间；覆盖成功、失败与 ComfyUI 恢复。
3. 添加独立耗时展示组件，运行中更新、结束后保留，清理定时器，使用等宽数字。
4. 执行构建和 lint；通过真实浏览器检查布局，并使用受控请求验证计时状态。
