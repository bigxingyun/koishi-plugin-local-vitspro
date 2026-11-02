import { AudioResult, Backend, SpeakerBase } from '../types'
import { AdapterContext, SynthesizeRequest, VitsAdapter } from './base'
import { BackendError } from '../core/errors'

/**
 * QQ 声聊：不走 HTTP，直接让 OneBot 机器人发一条群 AI 语音。
 * 因此返回 `sent: true`，上层不要再发消息。
 */
export class QQVoiceAdapter extends VitsAdapter {
    readonly type = 'qq-voice' as const

    constructor(ctx: AdapterContext) {
        super(ctx)
    }

    async synthesize(request: SynthesizeRequest): Promise<AudioResult> {
        const session = request.session
        if (!session) {
            throw new BackendError('BAD_REQUEST', 'QQ 声聊需要 session 对象')
        }
        if (session.platform !== 'onebot' && !session.onebot) {
            throw new BackendError('BAD_REQUEST', 'QQ 声聊仅支持 OneBot 协议')
        }
        if (session.isDirect) {
            throw new BackendError('BAD_REQUEST', 'QQ 声聊仅支持在群聊中使用')
        }

        const characterId = (request.speaker as SpeakerBase).characterId
        if (!characterId) {
            throw new BackendError('BAD_REQUEST', 'QQ 声聊缺少角色 id')
        }

        try {
            await session.onebot._request('send_group_ai_record', {
                group_id: session.guildId,
                character: String(characterId),
                text: request.text
            })
        } catch (error) {
            throw new BackendError(
                'SERVER',
                `QQ 声聊发送失败：${(error as Error)?.message ?? error}`,
                undefined,
                { cause: error }
            )
        }

        return { data: Buffer.alloc(0), mime: 'audio/wav', sent: true }
    }

    async getSpeakers(backend: Backend): Promise<SpeakerBase[]> {
        return backend.speakers ?? []
    }
}
