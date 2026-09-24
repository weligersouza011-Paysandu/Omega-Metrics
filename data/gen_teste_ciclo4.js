const XLSX = require('xlsx');

const headers = ['Nome do Funcionário', 'Matrícula', 'Nome do Cargo', 'Nome do Departamento', 'Dia', 'Status', 'Entrada 1', 'Saída 2', 'Total Normais'];
const rows = [
  ['Ana Silva', '1001', 'Operador', 'Obra A', '01/02/2026', 'Advertencia', '08:00', '17:00', 8],
  ['Bruno Costa', '1002', 'Operador', 'Obra A', '01/02/2026', 'Atestado Medico', '', '', 0],
  ['Carla Souza', '1003', 'Eletricista', 'Obra B', '01/02/2026', 'Atestado', '', '', 0],
  ['Diego Lima', '1004', 'Servente', 'Obra B', '01/02/2026', 'Declaração Banco', '', '', 0],
  ['Eva Ramos', '1005', 'Operador', 'Obra A', '01/02/2026', 'Boletim de Ocorrencia', '', '', 0],
  ['Fábio Melo', '1006', 'Soldador', 'Obra C', '01/02/2026', 'Obito', '', '', 0],
  ['Gina Prado', '1007', 'Operadora', 'Obra A', '01/02/2026', 'FÉRIAS', '', '', 0],
  ['Hugo Reis', '1008', 'Mestre', 'Obra C', '01/02/2026', 'FOLGA', '', '', 0],
  ['Iara Nunes', '1009', 'Operadora', 'Obra A', '01/02/2026', 'PRESENTE', '08:00', '17:00', 8],
  ['João Pedro', '1010', 'Motorista', 'Obra B', '01/02/2026', 'FALTA SEM JUSTIFICATIVA', '', '', 0],
  ['Kelly Dias', '1011', 'Operadora', 'Obra A', '01/02/2026', 'DEMITIDO', '', '', 0],
  ['Liam Torres', '1012', 'Eletricista', 'Obra B', '01/02/2026', 'XYZ_INVENTADO', '08:00', '17:00', 8]
];

const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Ponto');
XLSX.writeFile(wb, 'data/teste_ciclo4.xlsx');
console.log('OK data/teste_ciclo4.xlsx');
