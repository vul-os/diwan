/**
 * ArrangeToolbar.jsx — contextual toolbar shown when object(s) are selected (P3).
 *
 * Surfaces z-order, group/ungroup, align, and distribute. Pure presentational:
 * it calls the pure ops in slideArrange.js via the handlers passed down and lets
 * the parent persist. Dark-aesthetic primitives (IconButton/Tooltip/divider)
 * match the redesign; every control is keyboard reachable + aria-labelled.
 */

import {
  BringToFront, SendToBack, ChevronUp, ChevronDown,
  Group, Ungroup, Trash2,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
} from 'lucide-react'
import { IconButton, Tooltip } from '../../components/ui'
import type { AlignEdge, DistributeAxis } from './slideArrange'

type ArrangeAction =
  | 'bringToFront' | 'bringForward' | 'sendBackward' | 'sendToBack'
  | 'group' | 'ungroup' | 'align' | 'distribute'

interface ArrangeToolbarProps {
  count: number
  canGroup: boolean
  canUngroup: boolean
  onArrange: (action: ArrangeAction, arg?: AlignEdge | DistributeAxis) => void
  onDelete: () => void
}

export default function ArrangeToolbar({
  count, canGroup, canUngroup, onArrange, onDelete,
}: ArrangeToolbarProps) {
  const Sep = () => <span className="toolbar-divider" />
  const multi = count > 1
  const canDistribute = count >= 3
  return (
    <div
      className="toolbar-surface flex items-center gap-0.5 px-2 sm:px-3 h-auto min-h-10 py-1 flex-wrap"
      role="toolbar"
      aria-label="Arrange objects"
      aria-orientation="horizontal"
    >
      <span className="text-2xs font-semibold text-ink-faint uppercase tracking-eyebrow pr-1">
        {count} selected
      </span>
      <Sep />
      {/* z-order */}
      <Tooltip label="Bring to front">
        <IconButton size="sm" onClick={() => onArrange('bringToFront')} aria-label="Bring to front">
          <BringToFront size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Bring forward">
        <IconButton size="sm" onClick={() => onArrange('bringForward')} aria-label="Bring forward">
          <ChevronUp size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Send backward">
        <IconButton size="sm" onClick={() => onArrange('sendBackward')} aria-label="Send backward">
          <ChevronDown size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Send to back">
        <IconButton size="sm" onClick={() => onArrange('sendToBack')} aria-label="Send to back">
          <SendToBack size={14} />
        </IconButton>
      </Tooltip>

      <Sep />
      {/* group / ungroup */}
      <Tooltip label="Group (⌘G)">
        <IconButton size="sm" disabled={!canGroup} onClick={() => onArrange('group')} aria-label="Group">
          <Group size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Ungroup (⌘⇧G)">
        <IconButton size="sm" disabled={!canUngroup} onClick={() => onArrange('ungroup')} aria-label="Ungroup">
          <Ungroup size={14} />
        </IconButton>
      </Tooltip>

      <Sep />
      {/* align */}
      <Tooltip label="Align left"><IconButton size="sm" onClick={() => onArrange('align', 'left')} aria-label="Align left"><AlignStartVertical size={14} /></IconButton></Tooltip>
      <Tooltip label="Align center"><IconButton size="sm" onClick={() => onArrange('align', 'center')} aria-label="Align center"><AlignCenterVertical size={14} /></IconButton></Tooltip>
      <Tooltip label="Align right"><IconButton size="sm" onClick={() => onArrange('align', 'right')} aria-label="Align right"><AlignEndVertical size={14} /></IconButton></Tooltip>
      <Tooltip label="Align top"><IconButton size="sm" onClick={() => onArrange('align', 'top')} aria-label="Align top"><AlignStartHorizontal size={14} /></IconButton></Tooltip>
      <Tooltip label="Align middle"><IconButton size="sm" onClick={() => onArrange('align', 'middle')} aria-label="Align middle"><AlignCenterHorizontal size={14} /></IconButton></Tooltip>
      <Tooltip label="Align bottom"><IconButton size="sm" onClick={() => onArrange('align', 'bottom')} aria-label="Align bottom"><AlignEndHorizontal size={14} /></IconButton></Tooltip>

      {canDistribute && (
        <>
          <Sep />
          <Tooltip label="Distribute horizontally"><IconButton size="sm" onClick={() => onArrange('distribute', 'horizontal')} aria-label="Distribute horizontally"><AlignHorizontalDistributeCenter size={14} /></IconButton></Tooltip>
          <Tooltip label="Distribute vertically"><IconButton size="sm" onClick={() => onArrange('distribute', 'vertical')} aria-label="Distribute vertically"><AlignVerticalDistributeCenter size={14} /></IconButton></Tooltip>
        </>
      )}

      <Sep />
      <Tooltip label="Delete (⌫)">
        <IconButton size="sm" className="hover:text-danger" onClick={onDelete} aria-label="Delete object">
          <Trash2 size={14} />
        </IconButton>
      </Tooltip>
      {multi && <span className="sr-only">Multiple objects selected</span>}
    </div>
  )
}
