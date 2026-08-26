<!--
  Fixture for the framework-plugin boundary — docs/virtual-filesystem.md open
  item 2. A `.vue` file is not JavaScript, so without a compiler the bundler has
  nothing to do with it and the build fails outright.

  Deliberately uses the three things a real SFC does and a trivial one does not:
  `<script setup lang="ts">` (the compiled script still carries types),
  a child component import, and a `scoped` style (which needs a scope id
  threaded through the template compile and onto the component).
-->
<script setup lang="ts">
import { ref } from 'vue'
import Counter from './Counter.vue'

const title = ref('Sample Vue App')
</script>

<template>
  <div class="container">
    <h1>{{ title }}</h1>
    <Counter />
  </div>
</template>

<style scoped>
.container {
  padding: 2rem;
}
</style>
