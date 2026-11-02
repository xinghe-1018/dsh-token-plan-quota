/**
 * 递归枚举时的跳过集合 —— **两份门禁共用一份**（check-refs 的活文档扫描、check-docs 的编码护栏）。
 *
 * 为什么共用：0.4.12 对齐发布线时只给 check-refs 加了 `.qoder`，编码护栏还在用它自己
 * 那份清单，于是同一句「门禁的扫描面不含它」在两份代码里一半真一半假（Open Code Review 的
 * 第一条发现，已核：按旧清单枚举会读进 57 份 IDE 生成文档）。本项目对这类事的既定立场是
 * 「换算只有一处」，扫描面同理。
 *
 * 为什么这些目录不算仓库内容：.git 无活文档且量极大；node_modules 与截图中间产物可重生成；
 * .qoder（IDE 的 repowiki 缓存）与 .dsh（Spec Kit 重新生成的技能）都已在 .gitignore 里，
 * 不属于仓库，也就不属于「活文档 / 必须无损编码的文本」这两个面。判红它们等于要求用户去修
 * 一份本地根本没有的生成物。
 */
// 导出**判定函数**而不是 Set：Set 是活的，任何消费者在 require 时 add/delete 一笔，
// 改的就是另一道门禁的扫描面——而这个模块存在的前提正是「谁也不持有私有副本」（第五轮审查）。
const SKIP_DIRS = new Set(['.git', 'node_modules', '.shots-work', '.scratch', '.qoder', '.dsh'])

/**
 * @param name - 目录名（不是路径）。
 * @returns 递归枚举时是否跳过该目录。
 */
export function shouldSkipDir(name) {
  return SKIP_DIRS.has(name)
}

/** 供守卫与调试使用：当前跳过集合的只读快照。 */
export const skipDirNames = Object.freeze([...SKIP_DIRS])
