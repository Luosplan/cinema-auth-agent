<script setup>
import Sidebar from './components/Sidebar/index.vue'
</script>

<template>
  <div class="common-layout">
    <el-container>
      <Sidebar />
      <el-container>
        <el-main><router-view></router-view></el-main>
      </el-container>
    </el-container>
  </div>
</template>

<style lang="scss" scoped>
.common-layout {
  height: 100%;
  overflow: hidden;
}

.common-layout :deep(.el-container) {
  height: 100%;
}

.common-layout :deep(.el-main) {
  padding: 0;
  overflow: hidden;
  background: #f7f8fa;
}
</style>
