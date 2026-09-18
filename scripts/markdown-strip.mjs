/**
 * 扫描前的"中和"处理：把 **代码示例** 从 Markdown 里抹掉，只留散文。
 *
 * 为什么单独一个模块：两个消费者对"什么算示例"必须有**同一个答案**——
 * `check-refs.mjs` 找 `文件:行号` 引用、`link-targets.mjs` 找 README 的链接声明。
 * 如果各写一份剥离实现，就会出现"同一段文本在一个检查里算示例、在另一个检查里算声明"的分叉，
 * 而这正是 003 整套改动要消灭的东西。所以剥离只有这一处实现。
 *
 * 历史教训（评审 Lens 1 报的 HIGH）：最初的写法是 `text.replace(/```[\s\S]*?```/g, ' ')`，
 * 它把第 1/3/5… 个三反引号与下一个两两配对。于是**正文里游离的一个三反引号**就会把该文件
 * 后半段的奇偶翻转：散文段被当围栏剥掉（**假绿**）、围栏内的示例被当散文扫（**假红**），
 * 同一次编辑同时造出两个方向的错。`~~~` 围栏（合法 CommonMark）它更是完全不认。
 * 本仓库真的踩过：`workflow/ENVIRONMENT.md` 讲 pwsh 转义时写了一处含三反引号的字面量，
 * 于是全文件的三反引号计数是奇数。
 */

/**
 * 剥掉代码围栏（``` 与 ~~~ 两种，CommonMark 式状态机，按行判定）。
 * 未闭合的围栏按 CommonMark 处理：其后的内容都算围栏内。
 * @param {string} text Markdown 原文
 * @returns {string} 围栏内容被替换成空格后的文本（**行数不变**，便于对回原文）
 */
export function stripFences(text) {
  const out = []
  let fence = null   // { char, len }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (open !== null) {
        fence = { char: open[1][0], len: open[1].length }
        out.push(' ')
      } else out.push(line)
    } else {
      // 闭合围栏：同种字符、长度不少于开启者，且其后只有空白。
      if (new RegExp(`^ {0,3}\\${fence.char}{${fence.len},}\\s*$`).test(line)) fence = null
      out.push(' ')
    }
  }
  return out.join('\n')
}

/**
 * 在 `stripFences` 之上再剥**行内代码**（反引号片段）。
 * 用在"声明"类扫描上：`` `[x](workflow/foo.md)` `` 是举例，不是对外声明。
 * `check-refs.mjs` **不用**这一层——被禁的行号引用绝大多数恰恰写在反引号里。
 * @param {string} text Markdown 原文
 * @returns {string} 围栏与行内代码都被替换成空格后的文本
 */
export function stripCode(text) {
  return stripFences(text).replace(/`[^`\n]*`/g, ' ')
}