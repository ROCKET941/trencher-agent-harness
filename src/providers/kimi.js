import { ChatProvider } from './chat.js'
export class KimiProvider extends ChatProvider { constructor(options={}){super('kimi','/v1/chat/completions',options)} }
