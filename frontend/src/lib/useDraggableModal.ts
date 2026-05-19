import { useCallback, useEffect, useRef, useState } from 'react'

interface Offset {
  x: number
  y: number
}

interface DragState {
  active: boolean
  pointerId: number | null
  startClientX: number
  startClientY: number
  startOffsetX: number
  startOffsetY: number
}

export function useDraggableModal() {
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const dragStateRef = useRef<DragState>({
    active: false,
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
  })

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      const drag = dragStateRef.current
      if (!drag.active || drag.pointerId !== event.pointerId) return
      const nextX = drag.startOffsetX + (event.clientX - drag.startClientX)
      const nextY = drag.startOffsetY + (event.clientY - drag.startClientY)
      setOffset({ x: nextX, y: nextY })
    }

    function onPointerUp(event: PointerEvent) {
      const drag = dragStateRef.current
      if (!drag.active || drag.pointerId !== event.pointerId) return
      dragStateRef.current = {
        ...drag,
        active: false,
        pointerId: null,
      }
      document.body.style.userSelect = ''
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      document.body.style.userSelect = ''
    }
  }, [])

  const onHandlePointerDown = useCallback((event: { button: number; pointerId: number; clientX: number; clientY: number }) => {
    if (event.button !== 0) return
    dragStateRef.current = {
      active: true,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffsetX: offset.x,
      startOffsetY: offset.y,
    }
    document.body.style.userSelect = 'none'
  }, [offset.x, offset.y])

  const resetOffset = useCallback(() => {
    setOffset({ x: 0, y: 0 })
  }, [])

  return {
    offset,
    onHandlePointerDown,
    resetOffset,
  }
}
