import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import {latexParser} from 'latex-utensils'

export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
}

export function escapeRegExp(str: string) {
    return str.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')
}

/**
 * Strip text and comments from LaTeX, leaving only commands and environments.
 *
 * @param raw The raw LaTeX content as a string
 * @returns The stripped LaTeX command barebone
 */
export function stripText(raw: string): string {
    const text = stripComments(raw)
    // We first create an array of empty strings, each of which corresponds to
    // one line in the original document.
    const result = Array(text.split('\n').length).fill('')
    // The following regex defines a LaTeX command.
    // We also consider a special case of verbatim "label={something}"
    const cmdReg = /(\\(?:[^a-zA-Z@]|[a-zA-Z@]+[*=']?))|(label={[^{}]+})/gm
    let match
    while ((match = cmdReg.exec(text)) !== null) {
        // Stores the complete command, including arguments.
        let matchedText = match[0]
        // match[1]: command, null on "label={something}"
        // There is an (optional) argument after the command. They can be many.
        while (['{', '['].includes(text[cmdReg.lastIndex])) {
            const isCurly = text[cmdReg.lastIndex] === '{'
            const balanceStr = getLongestBalancedString(text.substring(cmdReg.lastIndex), isCurly ? undefined : 'square')
            matchedText += isCurly ? `{${balanceStr}}` : `[${balanceStr}]`
            cmdReg.lastIndex += balanceStr.length + 2
            // It's possible to have spaces between arguments. If so, skip them.
            while (text[cmdReg.lastIndex] === ' ' || text[cmdReg.lastIndex] === '\t') {
                cmdReg.lastIndex++
            }
        }
        const line = text.substring(0, match.index).split('\n').length - 1
        // Append each line in the command to the array.
        matchedText.split('\n').forEach((content, index) => result[line+index] += content)
    }
    return result.join('\n')
}

/**
 * Remove comments
 *
 * @param text A string in which comments get removed.
 * @return the input text with comments removed.
 * Note the number lines of the output matches the input
 */
export function stripComments(text: string): string {
    const reg = /(^|[^\\]|(?:(?<!\\)(?:\\\\)+))%.*$/gm
    return text.replace(reg, '$1')
}

/**
 * Remove some environments
 * Note the number lines of the output matches the input
 *
 * @param text A string representing the content of a TeX file
 * @param envs An array of environments to be removed
 *
 */
export function stripEnvironments(text: string, envs: string[]): string {
    const envsAlt = envs.join('|')
    const pattern = `\\\\begin{(${envsAlt})}.*?\\\\end{\\1}`
    const reg = RegExp(pattern, 'gms')
    return text.replace(reg, (match, ..._args) => {
        const len = Math.max(match.split('\n').length, 1)
        return '\n'.repeat(len - 1)
    })
}

/**
 * Remove comments and verbatim content
 * Note the number lines of the output matches the input
 *
 * @param text A multiline string to be stripped
 * @return the input text with comments and verbatim content removed.
 */
export function stripCommentsAndVerbatim(text: string): string {
    let content = stripComments(text)
    content = content.replace(/\\verb\*?([^a-zA-Z0-9]).*?\1/g, '')
    const configuration = vscode.workspace.getConfiguration('latex-workshop')
    const verbatimEnvs = configuration.get('latex.verbatimEnvs') as string[]
    return stripEnvironments(content, verbatimEnvs)
}

/**
 * Trim leading and ending spaces on every line
 * See https://blog.stevenlevithan.com/archives/faster-trim-javascript for
 * possible ways of implementing trimming
 *
 * @param text a multiline string
 */
export function trimMultiLineString(text: string): string {
    return text.replace(/^\s\s*/gm, '').replace(/\s\s*$/gm, '')
}

/**
 * Find the longest substring containing balanced curly braces {...}
 * The string `s` can either start on the opening `{` or at the next character
 *
 * @param s A string to be searched.
 */
export function getLongestBalancedString(s: string, bracket: 'curly' | 'square'='curly'): string {
    const openner = bracket === 'curly' ? '{' : '['
    const closer = bracket === 'curly' ? '}' : ']'
    let nested = s[0] === openner ? 0 : 1
    let i = 0
    for (i = 0; i < s.length; i++) {
        switch (s[i]) {
            case openner:
                nested++
                break
            case closer:
                nested--
                break
            case '\\':
                // skip an escaped character
                i++
                break
            default:
        }
        if (nested === 0) {
            break
        }
    }
    return s.substring(s[0] === openner ? 1 : 0, i)
}

/**
 * If the current position is inside command{...}, return the range of command{...} and its argument. Otherwise return undefined
 *
 * @param command the command name, with or without the leading '\\'
 * @param position the current position in the document
 * @param document a TextDocument
 */
export function getSurroundingCommandRange(command: string, position: vscode.Position, document: vscode.TextDocument): {range: vscode.Range, arg: string} | undefined {
    if (!command.startsWith('\\')) {
        command = '\\' + command
    }
    const line = document.lineAt(position.line).text
    const regex = new RegExp('\\' + command + '{', 'g')
    while (true) {
        const match = regex.exec(line)
        if (!match) {
            break
        }
        const matchPos = match.index
        const openingBracePos = matchPos + command.length + 1
        const arg = getLongestBalancedString(line.slice(openingBracePos))
        if (position.character >= openingBracePos && position.character <= openingBracePos + arg.length + 1) {
            const start = new vscode.Position(position.line, matchPos)
            const end = new vscode.Position(position.line, openingBracePos + arg.length + 1)
            return {range: new vscode.Range(start, end), arg}
        }
    }
    return
}


export type CommandArgument = {
    arg: string, // The argument we are looking for
    index: number // the starting position of the argument
}

/**
 * @param text a string starting with a command call
 * @param nth the index of the argument to return
 */
export function getNthArgument(text: string, nth: number): CommandArgument | undefined {
    let arg: string = ''
    let index: number = 0 // start of the nth argument
    let offset: number = 0 // current offset of the new text to consider
    for (let i=0; i<nth; i++) {
        text = text.slice(offset)
        index += offset
        const start = text.indexOf('{')
        if (start === -1) {
            return
        }
        text = text.slice(start)
        index += start
        arg = getLongestBalancedString(text)
        offset = arg.length + 2 // 2 counts '{' and '}'
    }
    return {arg, index}
}

/**
 * Resolve a relative file path to an absolute path using the prefixes `dirs`.
 *
 * @param dirs An array of the paths of directories. They are used as prefixes for `inputFile`.
 * @param inputFile The path of a input file to be resolved.
 * @param suffix The suffix of the input file
 * @return an absolute path or undefined if the file does not exist
 */
export function resolveFile(dirs: string[], inputFile: string, suffix: string = '.tex'): string | undefined {
    if (inputFile.startsWith('/')) {
        dirs.unshift('')
    }
    for (const d of dirs) {
        let inputFilePath = path.resolve(d, inputFile)
        if (path.extname(inputFilePath) === '') {
            inputFilePath += suffix
        }
        if (!fs.existsSync(inputFilePath) && fs.existsSync(inputFilePath + suffix)) {
            inputFilePath += suffix
        }
        if (fs.existsSync(inputFilePath)) {
            return inputFilePath
        }
    }
    return
}

/**
 * Return a function replacing placeholders of LaTeX recipes.
 *
 * @param rootFile The path of the root file.
 * @param tmpDir The path of a temporary directory.
 * @returns A function replacing placeholders.
 */
export function replaceArgumentPlaceholders(rootFile: string, tmpDir: string): (arg: string) => string {
    return (arg: string) => {
        const configuration = vscode.workspace.getConfiguration('latex-workshop', vscode.Uri.file(rootFile))
        const docker = configuration.get('docker.enabled')

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
        const workspaceDir = workspaceFolder?.uri.fsPath.split(path.sep).join('/') || ''
        const rootFileParsed = path.parse(rootFile)
        const docfile = rootFileParsed.name
        const docfileExt = rootFileParsed.base
        const dirW32 = path.normalize(rootFileParsed.dir)
        const dir = dirW32.split(path.sep).join('/')
        const docW32 = path.join(dirW32, docfile)
        const doc = docW32.split(path.sep).join('/')
        const docExtW32 = path.join(dirW32, docfileExt)
        const docExt = docExtW32.split(path.sep).join('/')
        const relativeDir = path.relative(workspaceDir, dir).split(path.sep).join('/')
        const relativeDoc = path.relative(workspaceDir, doc).split(path.sep).join('/')

        const expandPlaceHolders = (a: string): string => {
            return a.replace(/%DOC%/g, docker ? docfile : doc)
                    .replace(/%DOC_W32%/g, docker ? docfile : docW32)
                    .replace(/%DOC_EXT%/g, docker ? docfileExt : docExt)
                    .replace(/%DOC_EXT_W32%/g, docker ? docfileExt : docExtW32)
                    .replace(/%DOCFILE_EXT%/g, docfileExt)
                    .replace(/%DOCFILE%/g, docfile)
                    .replace(/%DIR%/g, docker ? './' : dir)
                    .replace(/%DIR_W32%/g, docker ? './' : dirW32)
                    .replace(/%TMPDIR%/g, tmpDir)
                    .replace(/%WORKSPACE_FOLDER%/g, docker ? './' : workspaceDir)
                    .replace(/%RELATIVE_DIR%/, docker ? './' : relativeDir)
                    .replace(/%RELATIVE_DOC%/, docker ? docfile : relativeDoc)

        }
        const outDirW32 = path.normalize(expandPlaceHolders(configuration.get('latex.outDir') as string))
        const outDir = outDirW32.split(path.sep).join('/')
        return expandPlaceHolders(arg).replace(/%OUTDIR%/g, outDir).replace(/%OUTDIR_W32%/g, outDirW32)
    }
}

export type NewCommand = {
    kind: 'command',
    name: 'renewcommand|newcommand|providecommand|DeclareMathOperator|renewcommand*|newcommand*|providecommand*|DeclareMathOperator*',
    args: (latexParser.OptionalArg | latexParser.Group)[],
    location: latexParser.Location
}

export function isNewCommand(node: latexParser.Node | undefined): node is NewCommand {
    const regex = /^(renewcommand|newcommand|providecommand|DeclareMathOperator)(\*)?$/
    if (latexParser.isCommand(node) && node.name.match(regex)) {
        return true
    }
    return false
}

export type NewEnvironment = {
    kind: 'command',
    name: 'renewenvironment|newenvironment|renewenvironment*|newenvironment*',
    args: (latexParser.OptionalArg | latexParser.Group)[],
    location: latexParser.Location
}

export function isNewEnvironment(node: latexParser.Node | undefined): node is NewEnvironment {
    const regex = /^(renewenvironment|newenvironment)(\*)?$/
    if (latexParser.isCommand(node) && node.name.match(regex)) {
        return true
    }
    return false
}
