// 让 node 测试能直接加载用 @/ 别名的 TypeScript 源文件
import { register } from "node:module";

register("./alias-hooks.mjs", import.meta.url);
