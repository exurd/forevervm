#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { ForeverVM } from '@forevervm/sdk'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Command } from 'commander'
import { installForeverVM } from './install/index.js'

const DEFAULT_FOREVERVM_SERVER = 'https://api.forevervm.com'

interface ForeverVMOptions {
  token?: string
  baseUrl?: string
}

// Zod schema
const ExecMachineSchema = z.object({
  pythonCode: z.string(),
  replId: z.string(),
})

const RUN_REPL_TOOL_NAME = 'run-python-in-repl'
const CREATE_REPL_MACHINE_TOOL_NAME = 'create-python-repl'

export function getForeverVMOptions(): ForeverVMOptions {
  if (process.env.FOREVERVM_TOKEN) {
    return {
      token: process.env.FOREVERVM_TOKEN,
      baseUrl: process.env.FOREVERVM_BASE_URL || DEFAULT_FOREVERVM_SERVER,
    }
  }

  const configFilePath = path.join(os.homedir(), '.config', 'forevervm', 'config.json')

  if (!fs.existsSync(configFilePath)) {
    console.error('ForeverVM config file not found at:', configFilePath)
    process.exit(1)
  }

  try {
    const fileContent = fs.readFileSync(configFilePath, 'utf8')
    const config = JSON.parse(fileContent)

    if (!config.token) {
      console.error('ForeverVM config file does not contain a token')
      process.exit(1)
    }

    let baseUrl = config.server_url || DEFAULT_FOREVERVM_SERVER

    // remove trailing slash
    baseUrl = baseUrl.replace(/\/$/, '')

    return {
      token: config.token,
      baseUrl,
    }
  } catch (error) {
    console.error('Failed to read ForeverVM config file:', error)
    process.exit(1)
  }
}

// ForeverVM integration
interface ExecReplResponse {
  output: string
  result: string
  replId: string
  error?: string
  image?: string
}
async function makeExecReplRequest(
  forevervmOptions: ForeverVMOptions,
  pythonCode: string,
  replId: string,
): Promise<ExecReplResponse> {
  try {
    const fvm = new ForeverVM(forevervmOptions)

    const repl = await fvm.repl(replId)

    const execResult = await repl.exec(pythonCode)

    const output: string[] = []
    for await (const nextOutput of execResult.output) {
      output.push(nextOutput.data)
    }

    const result = await execResult.result
    const imageResult = result.data?.['png'] as string | undefined

    if (typeof result.value === 'string') {
      return {
        output: output.join('\n'),
        result: result.value,
        replId: replId,
        image: imageResult,
      }
    } else if (result.value === null) {
      return {
        output: output.join('\n'),
        result: 'The code did not return a value',
        replId: replId,
        image: imageResult,
      }
    } else if (result.error) {
      return {
        output: output.join('\n'),
        result: '',
        replId: replId,
        error: `Error: ${result.error}`,
        image: imageResult,
      }
    } else {
      return {
        output: output.join('\n'),
        result: 'No result or error returned',
        replId: replId,
        image: imageResult,
      }
    }
  } catch (error: any) {
    return {
      error: `Failed to execute Python code: ${error}`,
      output: '',
      result: '',
      replId: replId,
    }
  }
}

async function makeCreateMachineRequest(forevervmOptions: ForeverVMOptions): Promise<string> {
  try {
    console.error('using options', forevervmOptions)
    const fvm = new ForeverVM(forevervmOptions)

    const machine = await fvm.createMachine()

    return machine.machine_name
  } catch (error: any) {
    throw new Error(`Failed to create ForeverVM machine: ${error}`)
  }
}

// Start server
async function runMCPServer() {
  const forevervmOptions = getForeverVMOptions()

  const server = new Server(
    { name: 'forevervm', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )

  // List resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [], // No resources currently available
    }
  })

  // List prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [], // No prompts currently available
    }
  })

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: RUN_REPL_TOOL_NAME,
          description:
            'Run Python code in a given REPL. Common libraries including numpy, pandas, and requests are available to be imported. External API requests are allowed.',
          inputSchema: {
            type: 'object',
            properties: {
              pythonCode: {
                type: 'string',
                description: 'Python code to execute in the REPL.',
              },
              replId: {
                type: 'string',
                description:
                  'The ID corresponding with the REPL to run the Python code on. REPLs persist global state across runs. Create a REPL once per session with the create-python-repl tool.',
              },
            },
            required: ['pythonCode', 'replId'],
          },
        },
        {
          name: CREATE_REPL_MACHINE_TOOL_NAME,
          description:
            'Create a Python REPL. Global variables, imports, and function definitions are preserved between runs.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      ],
    }
  })

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      if (name === RUN_REPL_TOOL_NAME) {
        const { pythonCode, replId } = ExecMachineSchema.parse(args)
        const execResponse = await makeExecReplRequest(forevervmOptions, pythonCode, replId)

        if (execResponse.error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(execResponse),
                isError: true,
              },
            ],
          }
        }

        if (execResponse.image) {
          return {
            content: [
              {
                type: 'image',
                data: execResponse.image,
                mimeType: 'image/png',
              },
            ],
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(execResponse),
            },
          ],
        }
      } else if (name === CREATE_REPL_MACHINE_TOOL_NAME) {
        let replId
        try {
          replId = await makeCreateMachineRequest(forevervmOptions)
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Failed to create machine: ${error}` }],
            isError: true,
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: replId,
            },
          ],
        }
      } else {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        }
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid arguments: ${error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join(', ')}`,
        )
      }
      throw error
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

function main() {
  const program = new Command()

  program.name('forevervm-mcp').version('1.0.0')

  program
    .command('install')
    .description('Set up the ForeverVM MCP server')
    .option('-c, --claude', 'Set up the MCP Server for Claude Desktop')
    .option('-g, --goose', 'Set up the MCP Server for Codename Goose (CLI only)')
    .option('-w, --windsurf', 'Set up the MCP Server for Windsurf')
    .action(installForeverVM)

  program.command('run').description('Run the ForeverVM MCP server').action(runMCPServer)

  if (process.argv.length === 2) {
    program.outputHelp()
    return
  }

  program.parse(process.argv)
}

main()
