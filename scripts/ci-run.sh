#!/usr/bin/env bash
# CI 包装：失败时把输出的前 40 行以 ::error:: 注解吐出来。
#
# 为什么要这一层：Actions 的原始日志需要登录（带 token 的 REST 调用）才能下载，
# 而 check-run 的注解是公开可读的。本项目 2026-09-07 六个 job 一起红、本机全绿，
# 手里又没有 token，只能靠注解看到"CI 上到底崩在哪一行"——不然就只能对着平台/时区
# 这类猜想反复推 CI 试。
set -uo pipefail

out=$("$@" 2>&1)
status=$?
if [ "$status" -ne 0 ]; then
  printf '%s\n' "$out" | head -n 40 | sed 's/^/::error::/'
  exit "$status"
fi
printf '%s\n' "$out" | tail -n 3
