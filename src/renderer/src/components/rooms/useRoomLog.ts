import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { LOCAL, type Room, type RoomLine } from './room-types'

export function useRoomLog(roomId: string | null) {
  const [lines, setLines] = useState<RoomLine[]>([])
  const refresh = useCallback(async () => {
    if (!roomId) {
      setLines([])
      return
    }
    try {
      const result = await callRuntimeRpc<{ room: Room; lines: RoomLine[] }>(
        LOCAL,
        'orchestration.roomLog',
        { id: roomId }
      )
      setLines(result.lines)
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.useRoomLog.readFailed', 'Failed to read room log')}: ${(error as Error).message}`
      )
    }
  }, [roomId])
  useEffect(() => {
    void refresh()
    if (!roomId) {
      return
    }
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [refresh, roomId])
  return { lines, refresh }
}
