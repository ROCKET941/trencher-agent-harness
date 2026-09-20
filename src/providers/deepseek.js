import { ChatProvider } from './chat.js'
export class DeepSeekProvider extends ChatProvider { constructor(options={}){super('deepseek','/chat/completions',options)} }
