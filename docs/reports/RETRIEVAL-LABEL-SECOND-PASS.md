# 检索标注第二轮独立源码复核

复核日期：2026-10-04。复核者：Codex（AI）。状态：源码位置已逐题核对；不代表真人确认。

## 复核范围

我核对了 retrieval-questions.ts 中的 30 条问题，以及检索评测实际读取的固定源码快照：

| 仓库 | 固定版本 |
|---|---|
| developit/mitt | 6b41670516ed8e8b738612f60491995470aa63b3 |
| epoberezkin/fast-json-stable-stringify | 49e230da2c84247b29ad4de02c9395793caefd15 |
| developit/dlv | 3212139c05647ffe3f1b095acd46afa2f5f635dd |

复核依据是 E:\newagent\upstream\eval 下的索引源码快照及其 upstream.json。没有用带受控缺陷的任务工作区代替检索评测的基线源码。

## 逐题结论

30 条候选的目标文件与符号均能在固定源码中找到依据，没有需要删除的目标。下表给出最直接的证据范围；测试代码或同一功能的文档位置列为可接受的补充答案。

|编号|结论|目标与直接证据|复核说明|
|---|---|---|---|
|Q1|通过，收窄行范围|mitt / src/index.ts / mitt：66–73、82–91|on 注册与 off 移除分处两段。|
|Q2|通过，收窄行范围|mitt / src/index.ts / mitt：113–120|118 行按 type、event 的顺序调用 wildcard handler。|
|Q3|通过，收窄行范围|mitt / src/index.ts / mitt：106–107、115–116|事件处理器和 wildcard 处理器都在调用前复制数组。|
|Q4|通过|mitt / src/index.ts / Emitter：23–39|完整泛型接口。|
|Q5|通过|mitt / src/index.ts / EventHandlerMap：18–21|Map 的键和值类型定义。|
|Q6|通过，收窄行范围|mitt / README.md / Install：30–36|安装命令在第 35 行。|
|Q7|通过，收窄行范围|mitt / README.md / Typescript：83–98|strict 模式、类型推断及错误类型示例；test/test-types-compilation.ts 也有正反例。|
|Q8|通过|mitt / README.md / off：157–161|说明省略 handler 时移除该事件的全部 handler。|
|Q9|通过|mitt / README.md / emit：169–170|明确 wildcard handler 在事件类型 handler 之后执行。|
|Q10|通过|mitt / README.md / all：144–146|说明 all 是事件名到 handler 的 Map。|
|Q11|通过，收窄行范围|stringify / index.js / stringify：40–43|检测重复对象并按 cycles 选项输出标记或抛错。|
|Q12|通过，收窄行范围|stringify / index.js / stringify：25|固定基线把非有限数值序列化为 null。|
|Q13|通过，收窄行范围|stringify / index.js / stringify：29–35|第 33 行把无序列化结果的数组项写为 null。|
|Q14|通过，收窄行范围|stringify / index.js / stringify：46|对象键排序在第 46 行使用 comparator；比较器适配在 8–16 行。|
|Q15|通过，收窄行范围|stringify / index.js / stringify：20–22|调用对象的 toJSON。|
|Q16|通过|stringify / README.md / cmp：40–64、66–82|分别示例按 key 和按 value 排序。|
|Q17|通过|stringify / README.md / cycles：84–88|说明启用 cycle marker 及其结果不是有效 JSON 的限制。|
|Q18|通过|stringify / README.md / install：91–96|包含 npm install 命令。|
|Q19|通过，收窄行范围|stringify / README.md / benchmark：100–105|实际运行命令是 node benchmark。|
|Q20|通过|stringify / README.md / example：10–22|包含基础输入与确定性输出。|
|Q21|通过|dlv / index.js / dlv：1–7|完整函数同时处理点分路径与数组路径。|
|Q22|通过，收窄行范围|dlv / index.js / dlv：1、6|默认值参数在签名中声明，第 6 行仅在结果为 undefined 时返回默认值；README 48–52 有示例。|
|Q23|通过，收窄行范围|dlv / index.js / dlv：2–3|第 2 行接受数组或把点分字符串切成路径键；README 37–41 也有示例。|
|Q24|通过，收窄行范围|dlv / index.js / dlv：4|中间对象不可继续访问时转为 undefined；test.js 40、48–50 有边界样例。|
|Q25|通过，收窄行范围|dlv / index.js / dlv：6|与 undefined 严格比较，所以 0 和 false 会保留；test.js 58、61 是验证样例。|
|Q26|通过|dlv / README.md / Why?：8–12|说明实现仅 120 bytes，并说明支持的模块形态。|
|Q27|通过|dlv / README.md / Installation：15–17|包含 npm install 命令。|
|Q28|通过但建议改写问题|dlv / README.md / Usage：37–52；test.js：21–34、52–62|README 分别展示 dotted path、array key 和默认值；测试 helper 还对两种路径形式使用同一默认值。原措辞可能被理解成 README 对两种形式分别给了带默认值的例子。建议改成“Where does the README show dotted-path and array-key syntax, plus a separate optional default-value example?”|
|Q29|通过|dlv / README.md / Setter Counterparts：64–67|列出 dset 和 bury。|
|Q30|通过，收窄行范围|dlv / README.md / License：70–72|README 明确写明 MIT；仓库根 LICENSE 是补充来源，但当前评测索引的扩展名过滤不会收录无扩展名 LICENSE。|

17 条候选行范围需要收窄：Q1–Q3、Q6–Q7、Q11–Q15、Q19、Q22–Q25、Q28、Q30。Q28 的目标仍可接受，主要问题是查询句的精确含义。

## 评分边界

evaluate-retrieval.ts 的 matchesTarget 只比较目标文件路径和允许的符号名，不比较表中的行范围。因此本次行范围收窄不会改变已有 Recall@K 或 MRR。Q1–Q3 共用 mitt 函数目标；Q11–Q15 共用 stringify 目标；Q21–Q25 共用 dlv 函数目标。当前数字衡量的是文件/符号级命中，不是精确代码片段或行级定位质量。

retrieval-v2 的 30 个问题各跑 keyword、dense、hybrid 一次，共 90 条检索记录。检索运行完整，但标签此前由 Agent 草拟；本复核是 AI 源码核对，不把结果改称为人工金标准。retrieval-v2/results.json 和 retrieval-questions.ts 中的 humanReviewed=false 应保持不变。

## 可交给真人的剩余确认

- 确认 Q28 是否采用上面的改写；若改动问题文本，旧检索分数不能当作改写后问题的分数，应另建 retrieval-v3 并保留旧批次。
- 确认是否接受“文件/符号级相关性”作为当前 R@5、MRR 的评测口径。若要衡量片段或行级准确性，须先扩展标注和评分器。
- 若真人尚未逐项审阅，不要把 humanReviewed 改为 true，也不要将当前指标描述为人工验证结果。
