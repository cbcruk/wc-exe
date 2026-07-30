import { useState } from 'react'

export function Counter(): JSX.Element {
  const [count, setCount] = useState(0)
  return (
    <div className="container">
      <h1>Sample React App</h1>
      <button id="counter" type="button" onClick={() => setCount(count + 1)}>
        count is {count}
      </button>
    </div>
  )
}
