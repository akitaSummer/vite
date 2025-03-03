// @ts-check
const babel = require('@babel/core')
const jsx = require('@vue/babel-plugin-jsx')
const importMeta = require('@babel/plugin-syntax-import-meta')
const { createFilter, normalizePath } = require('@rollup/pluginutils')
const hash = require('hash-sum')
const path = require('path')

const ssrRegisterHelperId = '/__vue-jsx-ssr-register-helper'
const ssrRegisterHelperCode =
    `import { useSSRContext } from "vue"\n` +
    `export ${ssrRegisterHelper.toString()}`

/**
 * This function is serialized with toString() and evaluated as a virtual
 * module during SSR
 * @param {import('vue').ComponentOptions} comp
 * @param {string} filename
 */
function ssrRegisterHelper(comp, filename) {
    const setup = comp.setup
    comp.setup = (props, ctx) => {
        // @ts-ignore
        const ssrContext = useSSRContext();
        (ssrContext.modules || (ssrContext.modules = new Set())).add(filename)
        if (setup) {
            return setup(props, ctx)
        }
    }
}

/**
 * @typedef { import('@rollup/pluginutils').FilterPattern} FilterPattern
 * @typedef { { include?: FilterPattern, exclude?: FilterPattern, babelPlugins?: any[] } } CommonOptions
 */

/**
 *
 * @param {import('@vue/babel-plugin-jsx').VueJSXPluginOptions & CommonOptions} options
 * @returns {import('vite').Plugin}
 */
function vueJsxPlugin(options = {}) {
    let root = '' // 项目根目录
    let needHmr = false // 是否需要hmr
    let needSourceMap = true // 是否需要sourceMap

    return {
        name: 'vite:vue-jsx',

        config(config) {
            return {
                // only apply esbuild to ts files
                // 插件已处理除ts以外的文件，无需再处理
                esbuild: {
                    include: /\.ts$/
                },
                define: {
                    __VUE_OPTIONS_API__: true,
                    __VUE_PROD_DEVTOOLS__: false,
                    ...config.define
                }
            }
        },

        configResolved(config) {
            needHmr = config.command === 'serve' && !config.isProduction // 处于开发状态，需要hmr
            needSourceMap = config.command === 'serve' || !!config.build.sourcemap // 开发状态，需要sourceMap
            root = config.root // 项目根目录
        },

        resolveId(id) {
            if (id === ssrRegisterHelperId) {
                return id
            }
        },

        load(id) {
            if (id === ssrRegisterHelperId) {
                return ssrRegisterHelperCode
            }
        },

        transform(code, id, opt) { // code: 代码， id： 文件id， opt：ssr等相关
            const ssr = typeof opt === 'boolean' ? opt : (opt && opt.ssr) === true
            const {
                include,
                exclude,
                babelPlugins = [],
                ...babelPluginOptions
            } = options

            const filter = createFilter(include || /\.[jt]sx$/, exclude) // rollup中帮助判断是否处理的函数

            if (filter(id)) { // 如果需要处理
                const plugins = [importMeta, [jsx, babelPluginOptions], ...babelPlugins] // importMeta：增加importMeta， jsx： jsx-plugin， babelPluginOptions配置项
                if (id.endsWith('.tsx')) { // 如果是tsx，加入tsx插件
                    plugins.push([
                        require('@babel/plugin-transform-typescript'),
                        // @ts-ignore
                        { isTSX: true, allowExtensions: true }
                    ])
                }

                const result = babel.transformSync(code, { // 得到ast
                    babelrc: false,
                    ast: true,
                    plugins,
                    sourceMaps: needSourceMap,
                    sourceFileName: id,
                    configFile: false
                })

                if (!ssr && !needHmr) { // 非ssr和hmr直接返回
                    return {
                        code: result.code,
                        map: result.map
                    }
                }

                // check for hmr injection
                /**
                 * @type {{ name: string }[]}
                 */
                const declaredComponents = []
                    /**
                     * @type {{
                     *  local: string,
                     *  exported: string,
                     *  id: string,
                     * }[]}
                     */
                const hotComponents = []
                let hasDefault = false

                for (const node of result.ast.program.body) { // result.ast.program ast处理结果， 遍历body获取结点
                    if (node.type === 'VariableDeclaration') { // 如果是const等赋值
                        const names = parseComponentDecls(node, code) // 判断是否是component组件
                        if (names.length) {
                            declaredComponents.push(...names)
                        }
                    }

                    if (node.type === 'ExportNamedDeclaration') { // 是否是导出变量声明： export const a = xxx
                        if (
                            node.declaration &&
                            node.declaration.type === 'VariableDeclaration' // 如果是const等赋值
                        ) {
                            hotComponents.push(
                                ...parseComponentDecls(node.declaration, code).map( // 判断是否是component组件
                                    ({ name }) => ({
                                        local: name, // 函数名
                                        exported: name, // 导出名
                                        id: hash(id + name) // 文件名和变量名组成hash
                                    })
                                )
                            )
                        } else if (node.specifiers.length) { // 判断是否是 export { A }
                            for (const spec of node.specifiers) {
                                if (
                                    spec.type === 'ExportSpecifier' &&
                                    spec.exported.type === 'Identifier'
                                ) {
                                    const matched = declaredComponents.find(
                                        ({ name }) => name === spec.local.name
                                    )
                                    if (matched) {
                                        hotComponents.push({
                                            local: spec.local.name,
                                            exported: spec.exported.name,
                                            id: hash(id + spec.exported.name)
                                        })
                                    }
                                }
                            }
                        }
                    }

                    if (node.type === 'ExportDefaultDeclaration') { // 判断是否是 export  default
                        if (node.declaration.type === 'Identifier') {
                            const _name = node.declaration.name
                            const matched = declaredComponents.find(
                                ({ name }) => name === _name
                            )
                            if (matched) {
                                hotComponents.push({
                                    local: node.declaration.name,
                                    exported: 'default',
                                    id: hash(id + 'default')
                                })
                            }
                        } else if (isDefineComponentCall(node.declaration)) {
                            hasDefault = true
                            hotComponents.push({
                                local: '__default__',
                                exported: 'default',
                                id: hash(id + 'default')
                            })
                        }
                    }
                }

                if (hotComponents.length) { // 所有export组件被存至hotComponents数组
                    if (hasDefault && (needHmr || ssr)) { // 如果有export default 
                        result.code =
                            result.code.replace(
                                /export default defineComponent/g,
                                `const __default__ = defineComponent`
                            ) + `\nexport default __default__`
                    }

                    if (needHmr && !ssr && !/\?vue&type=script/.test(id)) {
                        let code = result.code
                        let callbackCode = ``
                        for (const { local, exported, id }
                            of hotComponents) {
                            code +=
                                `\n${local}.__hmrId = "${id}"` +
                                `\n__VUE_HMR_RUNTIME__.createRecord("${id}", ${local})`
                            callbackCode += `\n__VUE_HMR_RUNTIME__.reload("${id}", __${exported})`
                        }

                        code += `\nimport.meta.hot.accept(({${hotComponents
              .map((c) => `${c.exported}: __${c.exported}`)
              .join(',')}}) => {${callbackCode}\n})`

            result.code = code
          }

          if (ssr) {
            const normalizedId = normalizePath(path.relative(root, id))
            let ssrInjectCode =
              `\nimport { ssrRegisterHelper } from "${ssrRegisterHelperId}"` +
              `\nconst __moduleId = ${JSON.stringify(normalizedId)}`
            for (const { local } of hotComponents) {
              ssrInjectCode += `\nssrRegisterHelper(${local}, __moduleId)`
            }
            result.code += ssrInjectCode
          }
        }

        return {
          code: result.code,
          map: result.map
        }
      }
    }
  }
}

/**
 * @param {import('@babel/core').types.VariableDeclaration} node
 * @param {string} source
 */
function parseComponentDecls(node, source) {
  const names = []
  for (const decl of node.declarations) { // declarations: 具体声明内容
    if (decl.id.type === 'Identifier' && isDefineComponentCall(decl.init)) { // 是否是isDefineComponent函数调用
      names.push({
        name: decl.id.name
      })
    }
  }
  return names
}

/**
 * @param {import('@babel/core').types.Node} node
 */
function isDefineComponentCall(node) {
  return (
    node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'defineComponent'
  )
}

module.exports = vueJsxPlugin
vueJsxPlugin.default = vueJsxPlugin