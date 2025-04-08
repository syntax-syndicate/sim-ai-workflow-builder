import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '@/lib/logs/console-logger'
import { executeTool } from '@/tools'
import { ProviderConfig, ProviderRequest, ProviderResponse, TimeSegment } from '../types'
import { prepareToolsWithUsageControl, trackForcedToolUsage } from '../utils'

const logger = createLogger('Anthropic Provider')

export const anthropicProvider: ProviderConfig = {
  id: 'anthropic',
  name: 'Anthropic',
  description: "Anthropic's Claude models",
  version: '1.0.0',
  models: ['claude-3-5-sonnet-20240620', 'claude-3-7-sonnet-20250219'],
  defaultModel: 'claude-3-7-sonnet-20250219',

  executeRequest: async (request: ProviderRequest): Promise<ProviderResponse> => {
    if (!request.apiKey) {
      throw new Error('API key is required for Anthropic')
    }

    const anthropic = new Anthropic({
      apiKey: request.apiKey,
      dangerouslyAllowBrowser: true,
    })

    // Helper function to generate a simple unique ID for tool uses
    const generateToolUseId = (toolName: string) => {
      return `${toolName}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
    }

    // Transform messages to Anthropic format
    const messages = []

    // Add system prompt if present
    let systemPrompt = request.systemPrompt || ''

    // Add context if present
    if (request.context) {
      messages.push({
        role: 'user',
        content: request.context,
      })
    }

    // Add remaining messages
    if (request.messages) {
      request.messages.forEach((msg) => {
        if (msg.role === 'function') {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.name,
                content: msg.content,
              },
            ],
          })
        } else if (msg.function_call) {
          const toolUseId = msg.function_call.name + '-' + Date.now()
          messages.push({
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: toolUseId,
                name: msg.function_call.name,
                input: JSON.parse(msg.function_call.arguments),
              },
            ],
          })
        } else {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content ? [{ type: 'text', text: msg.content }] : [],
          })
        }
      })
    }

    // Ensure there's at least one message
    if (messages.length === 0) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: systemPrompt || 'Hello' }],
      })
      // Clear system prompt since we've used it as a user message
      systemPrompt = ''
    }

    // Transform tools to Anthropic format if provided
    let anthropicTools = request.tools?.length
      ? request.tools.map((tool) => ({
          name: tool.id,
          description: tool.description,
          input_schema: {
            type: 'object',
            properties: tool.parameters.properties,
            required: tool.parameters.required,
          },
        }))
      : undefined

    // Set tool_choice based on usage control settings
    let toolChoice: 'none' | 'auto' | { type: 'tool'; name: string } = 'auto'

    // Handle tools and tool usage control
    if (anthropicTools?.length) {
      const {
        tools: filteredTools,
        toolChoice: tc,
        forcedTools,
      } = prepareToolsWithUsageControl(anthropicTools, request.tools, logger, 'anthropic')

      if (filteredTools?.length) {
        anthropicTools = filteredTools

        // No longer need conversion since provider-specific formatting is in prepareToolsWithUsageControl
        if (typeof tc === 'object' && tc !== null) {
          if (tc.type === 'tool') {
            toolChoice = tc
            logger.info(`Using Anthropic tool_choice format: force tool "${tc.name}"`)
          } else {
            // Default to auto if we got a non-Anthropic object format
            toolChoice = 'auto'
            logger.warn(`Received non-Anthropic tool_choice format, defaulting to auto`)
          }
        } else if (tc === 'auto' || tc === 'none') {
          toolChoice = tc
          logger.info(`Using tool_choice mode: ${tc}`)
        } else {
          // Default to auto if we got something unexpected
          toolChoice = 'auto'
          logger.warn(`Unexpected tool_choice format, defaulting to auto`)
        }
      }
    }

    // If response format is specified, add strict formatting instructions
    if (request.responseFormat) {
      // Get the schema from the response format
      const schema = request.responseFormat.schema || request.responseFormat

      // Build a system prompt for structured output based on the JSON schema
      let schemaInstructions = ''

      if (schema && schema.properties) {
        // Create a template of the expected JSON structure
        const jsonTemplate = Object.entries(schema.properties).reduce(
          (acc: Record<string, any>, [key, prop]: [string, any]) => {
            let exampleValue
            const propType = prop.type || 'string'

            // Generate appropriate example values based on type
            switch (propType) {
              case 'string':
                exampleValue = '"value"'
                break
              case 'number':
                exampleValue = '0'
                break
              case 'boolean':
                exampleValue = 'true'
                break
              case 'array':
                exampleValue = '[]'
                break
              case 'object':
                exampleValue = '{}'
                break
              default:
                exampleValue = '"value"'
            }

            acc[key] = exampleValue
            return acc
          },
          {}
        )

        // Generate field descriptions
        const fieldDescriptions = Object.entries(schema.properties)
          .map(([key, prop]: [string, any]) => {
            const type = prop.type || 'string'
            const description = prop.description ? `: ${prop.description}` : ''
            return `${key} (${type})${description}`
          })
          .join('\n')

        // Format the JSON template as a string
        const jsonTemplateStr = JSON.stringify(jsonTemplate, null, 2)

        schemaInstructions = `
IMPORTANT RESPONSE FORMAT INSTRUCTIONS:
1. Your response must be EXACTLY in this format, with no additional fields:
${jsonTemplateStr}

Field descriptions:
${fieldDescriptions}

2. DO NOT include any explanatory text before or after the JSON
3. DO NOT wrap the response in an array
4. DO NOT add any fields not specified in the schema
5. Your response MUST be valid JSON and include all the specified fields with their correct types`
      }

      systemPrompt = `${systemPrompt}${schemaInstructions}`
    }

    // Build the request payload
    const payload: any = {
      model: request.model || 'claude-3-7-sonnet-20250219',
      messages,
      system: systemPrompt,
      max_tokens: parseInt(String(request.maxTokens)) || 1024,
      temperature: parseFloat(String(request.temperature ?? 0.7)),
    }

    // Use the tools in the payload
    if (anthropicTools?.length) {
      payload.tools = anthropicTools
      // Only set tool_choice if it's not 'auto'
      if (toolChoice !== 'auto') {
        payload.tool_choice = toolChoice
      }
    }

    // Start execution timer for the entire provider execution
    const providerStartTime = Date.now()
    const providerStartTimeISO = new Date(providerStartTime).toISOString()

    try {
      // Make the initial API request
      const initialCallTime = Date.now()

      // Track the original tool_choice for forced tool tracking
      const originalToolChoice = payload.tool_choice

      // Track forced tools and their usage
      const forcedTools = anthropicTools?.length
        ? prepareToolsWithUsageControl(anthropicTools, request.tools, logger, 'anthropic')
            .forcedTools
        : []
      let usedForcedTools: string[] = []

      let currentResponse = await anthropic.messages.create(payload)
      const firstResponseTime = Date.now() - initialCallTime

      let content = ''

      // Extract text content from the message
      if (Array.isArray(currentResponse.content)) {
        content = currentResponse.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n')
      }

      let tokens = {
        prompt: currentResponse.usage?.input_tokens || 0,
        completion: currentResponse.usage?.output_tokens || 0,
        total:
          (currentResponse.usage?.input_tokens || 0) + (currentResponse.usage?.output_tokens || 0),
      }

      let toolCalls = []
      let toolResults = []
      let currentMessages = [...messages]
      let iterationCount = 0
      const MAX_ITERATIONS = 10 // Prevent infinite loops

      // Track if a forced tool has been used
      let hasUsedForcedTool = false

      // Track time spent in model vs tools
      let modelTime = firstResponseTime
      let toolsTime = 0

      // Track each model and tool call segment with timestamps
      const timeSegments: TimeSegment[] = [
        {
          type: 'model',
          name: 'Initial response',
          startTime: initialCallTime,
          endTime: initialCallTime + firstResponseTime,
          duration: firstResponseTime,
        },
      ]

      // Check if a forced tool was used in the first response
      if (typeof originalToolChoice === 'object' && Array.isArray(currentResponse.content)) {
        const toolUses = currentResponse.content.filter((item) => item.type === 'tool_use')

        if (toolUses.length > 0) {
          // Convert Anthropic tool_use format to a format trackForcedToolUsage can understand
          const adaptedToolCalls = toolUses.map((tool) => ({
            name: tool.name,
          }))

          // Convert Anthropic tool_choice format to match OpenAI format for tracking
          const adaptedToolChoice =
            originalToolChoice.type === 'tool'
              ? { function: { name: originalToolChoice.name } }
              : originalToolChoice

          const result = trackForcedToolUsage(
            adaptedToolCalls,
            adaptedToolChoice,
            logger,
            'anthropic',
            forcedTools,
            usedForcedTools
          )
          hasUsedForcedTool = result.hasUsedForcedTool
          usedForcedTools = result.usedForcedTools
        }
      }

      try {
        while (iterationCount < MAX_ITERATIONS) {
          // Check for tool calls
          const toolUses = currentResponse.content.filter((item) => item.type === 'tool_use')
          if (!toolUses || toolUses.length === 0) {
            break
          }

          // Track time for tool calls in this batch
          const toolsStartTime = Date.now()

          // Process each tool call
          for (const toolUse of toolUses) {
            try {
              const toolName = toolUse.name
              const toolArgs = toolUse.input as Record<string, any>

              // Get the tool from the tools registry
              const tool = request.tools?.find((t) => t.id === toolName)
              if (!tool) continue

              // Execute the tool
              const toolCallStartTime = Date.now()
              const mergedArgs = { ...tool.params, ...toolArgs }
              const result = await executeTool(toolName, mergedArgs)
              const toolCallEndTime = Date.now()
              const toolCallDuration = toolCallEndTime - toolCallStartTime

              if (!result.success) continue

              // Add to time segments
              timeSegments.push({
                type: 'tool',
                name: toolName,
                startTime: toolCallStartTime,
                endTime: toolCallEndTime,
                duration: toolCallDuration,
              })

              toolResults.push(result.output)
              toolCalls.push({
                name: toolName,
                arguments: toolArgs,
                startTime: new Date(toolCallStartTime).toISOString(),
                endTime: new Date(toolCallEndTime).toISOString(),
                duration: toolCallDuration,
                result: result.output,
              })

              // Add the tool call and result to messages
              const toolUseId = generateToolUseId(toolName)

              currentMessages.push({
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: toolUseId,
                    name: toolName,
                    input: toolArgs,
                  } as any,
                ],
              })

              currentMessages.push({
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: JSON.stringify(result.output),
                  } as any,
                ],
              })
            } catch (error) {
              logger.error('Error processing tool call:', { error })
            }
          }

          // Calculate tool call time for this iteration
          const thisToolsTime = Date.now() - toolsStartTime
          toolsTime += thisToolsTime

          // Make the next request with updated messages
          const nextPayload = {
            ...payload,
            messages: currentMessages,
          }

          // Update tool_choice based on which forced tools have been used
          if (
            typeof originalToolChoice === 'object' &&
            hasUsedForcedTool &&
            forcedTools.length > 0
          ) {
            // If we have remaining forced tools, get the next one to force
            const remainingTools = forcedTools.filter((tool) => !usedForcedTools.includes(tool))

            if (remainingTools.length > 0) {
              // Force the next tool - use Anthropic format
              nextPayload.tool_choice = {
                type: 'tool',
                name: remainingTools[0],
              }
              logger.info(`Forcing next tool: ${remainingTools[0]}`)
            } else {
              // All forced tools have been used, switch to auto by removing tool_choice
              delete nextPayload.tool_choice
              logger.info('All forced tools have been used, removing tool_choice parameter')
            }
          } else if (hasUsedForcedTool && typeof originalToolChoice === 'object') {
            // Handle the case of a single forced tool that was used
            delete nextPayload.tool_choice
            logger.info(
              'Removing tool_choice parameter for subsequent requests after forced tool was used'
            )
          }

          // Time the next model call
          const nextModelStartTime = Date.now()

          // Make the next request
          currentResponse = await anthropic.messages.create(nextPayload)

          // Check if any forced tools were used in this response
          if (
            typeof nextPayload.tool_choice === 'object' &&
            Array.isArray(currentResponse.content)
          ) {
            const toolUses = currentResponse.content.filter((item) => item.type === 'tool_use')

            if (toolUses.length > 0) {
              // Convert Anthropic tool_use format to a format trackForcedToolUsage can understand
              const adaptedToolCalls = toolUses.map((tool) => ({
                name: tool.name,
              }))

              // Convert Anthropic tool_choice format to match OpenAI format for tracking
              const adaptedToolChoice =
                nextPayload.tool_choice.type === 'tool'
                  ? { function: { name: nextPayload.tool_choice.name } }
                  : nextPayload.tool_choice

              const result = trackForcedToolUsage(
                adaptedToolCalls,
                adaptedToolChoice,
                logger,
                'anthropic',
                forcedTools,
                usedForcedTools
              )
              hasUsedForcedTool = result.hasUsedForcedTool || hasUsedForcedTool
              usedForcedTools = result.usedForcedTools
            }
          }

          const nextModelEndTime = Date.now()
          const thisModelTime = nextModelEndTime - nextModelStartTime

          // Add to time segments
          timeSegments.push({
            type: 'model',
            name: `Model response (iteration ${iterationCount + 1})`,
            startTime: nextModelStartTime,
            endTime: nextModelEndTime,
            duration: thisModelTime,
          })

          // Add to model time
          modelTime += thisModelTime

          // Update content if we have a text response
          const textContent = currentResponse.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n')

          if (textContent) {
            content = textContent
          }

          // Update token counts
          if (currentResponse.usage) {
            tokens.prompt += currentResponse.usage.input_tokens || 0
            tokens.completion += currentResponse.usage.output_tokens || 0
            tokens.total +=
              (currentResponse.usage.input_tokens || 0) + (currentResponse.usage.output_tokens || 0)
          }

          iterationCount++
        }
      } catch (error) {
        logger.error('Error in Anthropic request:', { error })
        throw error
      }

      // If the content looks like it contains JSON, extract just the JSON part
      if (content.includes('{') && content.includes('}')) {
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/m)
          if (jsonMatch) {
            content = jsonMatch[0]
          }
        } catch (e) {
          logger.error('Error extracting JSON from response:', { error: e })
        }
      }

      // Calculate overall timing
      const providerEndTime = Date.now()
      const providerEndTimeISO = new Date(providerEndTime).toISOString()
      const totalDuration = providerEndTime - providerStartTime

      return {
        content,
        model: request.model || 'claude-3-7-sonnet-20250219',
        tokens,
        toolCalls:
          toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                name: tc.name,
                arguments: tc.arguments as Record<string, any>,
                startTime: tc.startTime,
                endTime: tc.endTime,
                duration: tc.duration,
                result: tc.result,
              }))
            : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        timing: {
          startTime: providerStartTimeISO,
          endTime: providerEndTimeISO,
          duration: totalDuration,
          modelTime: modelTime,
          toolsTime: toolsTime,
          firstResponseTime: firstResponseTime,
          iterations: iterationCount + 1,
          timeSegments: timeSegments,
        },
      }
    } catch (error) {
      // Include timing information even for errors
      const providerEndTime = Date.now()
      const providerEndTimeISO = new Date(providerEndTime).toISOString()
      const totalDuration = providerEndTime - providerStartTime

      logger.error('Error in Anthropic request:', {
        error,
        duration: totalDuration,
      })

      // Create a new error with timing information
      const enhancedError = new Error(error instanceof Error ? error.message : String(error))
      // @ts-ignore - Adding timing property to the error
      enhancedError.timing = {
        startTime: providerStartTimeISO,
        endTime: providerEndTimeISO,
        duration: totalDuration,
      }

      throw enhancedError
    }
  },
}
