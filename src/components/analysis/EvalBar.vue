<script setup lang="ts">
// 评分条：红方胜率比例（上方红、下方黑），中间白线为均势
import { computed } from 'vue'

const props = defineProps<{
  /** 红方胜率 0-1 */
  winRateRed: number
}>()

const redPct = computed(() => Math.min(1, Math.max(0, props.winRateRed)) * 100)
</script>

<template>
  <div class="eval-bar" :title="`红方胜率 ${redPct.toFixed(1)}%`">
    <div class="red" :style="{ height: redPct + '%' }"></div>
  </div>
</template>

<style scoped>
.eval-bar {
  position: relative;
  width: 22px;
  height: 100%;
  min-height: 120px;
  background: #2c2c2c;
  border: 1px solid #999;
  border-radius: 6px;
  overflow: hidden;
}
.red {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(to top, #c0392b, #e74c3c);
  transition: height 0.25s ease;
}
</style>
