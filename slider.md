# Non-linear Slider cho Vue

## Bài toán

Slider có:

  Range        Step
  ---------- ------
  30s--1m        1s
  1m--5m        10s
  5m--30m        1m
  30m--1h        5m
  1h--12h       30m
  12h--24h       1h

Ngoài ra, **độ dài hiển thị của mỗi đoạn trên slider không tỉ lệ với giá
trị thực** (giống UptimeRobot).

------------------------------------------------------------------------

## Ý tưởng

Không dùng giá trị thời gian làm trục slider.

Tạo một **piecewise slider** gồm nhiều segment, mỗi segment có:

-   `start`: giá trị bắt đầu
-   `end`: giá trị kết thúc
-   `step`: bước nhảy
-   `width`: % chiều dài hiển thị trên slider

``` ts
const segments = [
  { start: 30, end: 60, step: 1, width: 18 },
  { start: 70, end: 300, step: 10, width: 18 },
  { start: 360, end: 1800, step: 60, width: 18 },
  { start: 2100, end: 3600, step: 300, width: 12 },
  { start: 5400, end: 43200, step: 1800, width: 20 },
  { start: 46800, end: 86400, step: 3600, width: 14 },
]
```

------------------------------------------------------------------------

## Cách 1 (Khuyến nghị): Slider chạy theo index

Sinh toàn bộ giá trị hợp lệ.

``` ts
function buildValues() {
  const values = []

  for (const s of segments) {
    for (let v = s.start; v <= s.end; v += s.step) {
      values.push(v)
    }
  }

  return values
}

const values = buildValues()
```

Ví dụ:

    30
    31
    ...
    60
    70
    80
    ...
    300
    360
    420
    ...
    86400

Slider chỉ chạy:

``` ts
index = 0 ... values.length - 1
```

Khi kéo:

``` ts
const value = values[index]
```

Ưu điểm:

-   Không cần step động.
-   Không cần xử lý số thực.
-   Dễ debug.
-   Hoạt động với mọi slider của Vue.

------------------------------------------------------------------------

## Cách 2: Value ↔ Position

### Tính offset

``` ts
let offset = 0

segments.forEach(s => {
  s.left = offset
  s.right = offset + s.width
  offset += s.width
})
```

### Value -\> Percent

``` ts
function valueToPercent(value: number) {
  const seg = segments.find(
    s => value >= s.start && value <= s.end
  )!

  const t =
    (value - seg.start) /
    (seg.end - seg.start)

  return seg.left + t * seg.width
}
```

### Percent -\> Value

``` ts
function percentToValue(percent: number) {
  const seg = segments.find(
    s => percent >= s.left && percent <= s.right
  )!

  const t =
    (percent - seg.left) /
    seg.width

  const raw =
    seg.start +
    t * (seg.end - seg.start)

  return Math.round(raw / seg.step) * seg.step
}
```

------------------------------------------------------------------------

## Tick labels

``` ts
const marks = [
  { value: 30, label: "30s" },
  { value: 60, label: "1m" },
  { value: 300, label: "5m" },
  { value: 1800, label: "30m" },
  { value: 3600, label: "1h" },
  { value: 43200, label: "12h" },
  { value: 86400, label: "24h" },
]
```

Render:

``` vue
<div
  v-for="m in marks"
  :key="m.value"
  class="mark"
  :style="{ left: valueToPercent(m.value) + '%' }"
>
  {{ m.label }}
</div>
```

------------------------------------------------------------------------

## Nếu dùng noUiSlider

`noUiSlider` hỗ trợ non-linear range và step theo từng đoạn.

Ví dụ:

``` js
range: {
  min: [30, 1],
  '15%': [60, 10],
  '30%': [300, 60],
  '45%': [1800, 300],
  '60%': [3600, 1800],
  '80%': [43200, 3600],
  max: [86400]
}
```

------------------------------------------------------------------------

## Kết luận

Nếu muốn giống UptimeRobot:

-   Slider chạy trên **trục ảo**, không phải thời gian thực.
-   Chia slider thành nhiều **segment**.
-   Mỗi segment có **width** và **step** riêng.
-   Mapping giữa `position ↔ value`.
-   Hoặc đơn giản hơn: slider chạy theo **index** và ánh xạ sang mảng
    `values`.
