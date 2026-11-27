// Dữ liệu mẫu. Thực tế file này do trang admin xuất ra (project3d.json) hoặc lấy từ API.
// Tọa độ tính bằng mét, gốc (0,0) ở góc trên-trái mặt bằng tổng thể.
(function () {
const R = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// Mặt bằng tầng điển hình của tòa S6.04 — vẽ căn hộ thật (không chia tự động).
// Hành lang giữa ở y 134–136, dãy bắc có hốc lõm lấy sáng ở giữa.
const S604_OUTLINE = [[112, 124], [138, 124], [138, 127], [170, 127], [170, 124], [196, 124], [196, 146], [112, 146]];
const S604_UNITS = [
  { no: '01', polygon: R(112, 124, 125, 134), type: '2PN', bedrooms: 2, bathrooms: 2, view: 'Nội khu' },
  { no: '02', polygon: R(125, 124, 138, 134), type: '2PN', bedrooms: 2, bathrooms: 2, view: 'Nội khu' },
  { no: '03', polygon: R(138, 127, 154, 134), type: '1PN+', bedrooms: 1, bathrooms: 1, view: 'Giếng trời' },
  { no: '04', polygon: R(154, 127, 170, 134), type: '1PN+', bedrooms: 1, bathrooms: 1, view: 'Giếng trời' },
  { no: '05', polygon: R(170, 124, 183, 134), type: '2PN', bedrooms: 2, bathrooms: 2, view: 'Nội khu' },
  { no: '06', polygon: R(183, 124, 196, 134), type: '2PN', bedrooms: 2, bathrooms: 2, view: 'Nội khu' },
  { no: '07', polygon: R(178, 136, 196, 146), type: '3PN góc', bedrooms: 3, bathrooms: 2, view: 'Công viên + đường lớn' },   // căn góc lớn
  { no: '08', polygon: R(166, 136, 178, 146), type: '2PN', bedrooms: 2, bathrooms: 2, view: 'Công viên' },
  { no: '09', polygon: R(154, 136, 166, 146), type: '2PN', bedrooms: 2, bathrooms: 2, view: 'Công viên' },
  { no: '10', polygon: R(142, 136, 154, 146), type: '2PN', bedrooms: 2, bathrooms: 2, view: 'Công viên' },
  { no: '11', polygon: R(130, 136, 142, 146), type: '2PN', bedrooms: 2, bathrooms: 2, view: 'Công viên' },
  { no: '12', polygon: R(112, 136, 130, 146), type: '3PN góc', bedrooms: 3, bathrooms: 2, view: 'Công viên + hồ bơi' },   // căn góc lớn
];
window.SAMPLE_PROJECT = {
  project: 'Dự án Demo Residence',
  ground: { image: null, widthMeters: 240, heightMeters: 180 },
  // pricePerM2 (đơn giá / m², VND) chỉ là số giả lập để demo giá tham khảo.
  // "units": { "S6.04-1307": { "status": "sold", "price": 5200000000 } }  ← dữ liệu thật theo mã căn từ hệ thống bán hàng
  // "status": { "S6.01-2501": "sold" }  ← trạng thái thật lấy từ hệ thống bán hàng; bỏ trống thì viewer tự giả lập
  towers: [
    {
      code: 'S6.01', pricePerM2: 68e6, color: '#0d9488', roofColor: '#7dd3c0',
      floors: 25, floorHeight: 3.2, floorHeightOverrides: { 1: 4.5, 2: 4.2, 3: 4.2 },
      unitsPerFloor: 14, nonSaleFloors: '1-3',
      plans: [
        { floorFrom: 1, floorTo: 3, polygon: [[36, 36], [104, 36], [104, 78], [36, 78]] },          // khối đế
        { floorFrom: 4, floorTo: 25, polygon: [[42, 42], [62, 42], [62, 47], [78, 47], [78, 42], [98, 42], [98, 72], [42, 72]] }, // thân tháp có hốc lõm
      ],
    },
    {
      code: 'S6.02', pricePerM2: 62e6, color: '#2563eb', roofColor: '#93c5fd',
      floors: 30, floorHeight: 3.2, floorHeightOverrides: { 1: 4.5, 2: 4.5 },
      unitsPerFloor: 12, nonSaleFloors: '1-2',
      plans: [
        { floorFrom: 1, floorTo: 2, polygon: [[134, 26], [206, 26], [206, 64], [176, 64], [176, 112], [134, 112]] },
        { floorFrom: 3, floorTo: 30, polygon: [[138, 30], [202, 30], [202, 58], [170, 58], [170, 108], [138, 108]] },   // hình chữ L
      ],
    },
    {
      code: 'S6.03', pricePerM2: 58e6, color: '#db2777', roofColor: '#f9a8d4',
      floors: 20, floorHeight: 3.2, floorHeightOverrides: { 1: 4.5 },
      unitsPerFloor: 8, nonSaleFloors: '1',
      plans: [
        { floorFrom: 1, floorTo: 16, polygon: [[40, 104], [86, 104], [86, 146], [40, 146]] },
        { floorFrom: 17, floorTo: 20, polygon: [[46, 110], [80, 110], [80, 140], [46, 140]] },      // giật cấp ở 4 tầng trên
      ],
    },
    {
      code: 'S6.04', pricePerM2: 65e6, color: '#ea580c', roofColor: '#7dd3c0',
      floors: 24, floorHeight: 3.2, floorHeightOverrides: { 1: 4.8 },
      unitsPerFloor: 12, nonSaleFloors: '1',
      plans: [
        { floorFrom: 1, floorTo: 1, polygon: [[110, 122], [198, 122], [198, 148], [110, 148]] },     // sảnh
        { floorFrom: 2, floorTo: 24, polygon: S604_OUTLINE, units: S604_UNITS },                    // tầng điển hình có căn vẽ tay
      ],
    },
  ],
};
})();
