/** A form with Datasets, a Grid, a container and expressions, for the stage B tests. */
export const SAMPLE_B = `{
  "formatVersion": 1,
  "id": "demo.Staff",
  "size": { "width": 800, "height": 600 },
  "datasets": [
    {
      "id": "dsEmp",
      "keys": ["empNo"],
      "columns": [
        { "id": "empNo", "type": "string" },
        { "id": "name", "type": "string", "label": "Name" },
        { "id": "salary", "type": "decimal" }
      ],
      "sampleRows": [
        { "empNo": "E1", "name": "Ann", "salary": "100.5" },
        { "empNo": "E2", "name": "Bob", "salary": "200" }
      ]
    },
    {
      "id": "dsDept",
      "columns": [
        { "id": "code", "type": "string" },
        { "id": "title", "type": "string" }
      ]
    }
  ],
  "components": [
    {
      "id": "panel",
      "type": "Panel",
      "layout": { "left": 20, "top": 30, "width": 400, "height": 300 },
      "children": [
        {
          "id": "nameInput",
          "type": "TextInput",
          "layout": { "left": 10, "top": 10, "width": 150, "height": 24 },
          "props": { "label": "Name" },
          "bind": { "value": "dsEmp.name" }
        },
        {
          "id": "dept",
          "type": "ComboBox",
          "layout": { "left": 10, "top": 50, "width": 150, "height": 24 },
          "props": { "optionValue": "code", "optionLabel": "title" },
          "bind": { "value": "dsEmp.empNo", "options": "dsDept" }
        },
        {
          "id": "inner",
          "type": "Panel",
          "layout": { "right": 10, "bottom": 10, "width": 100, "height": 100 }
        }
      ]
    },
    {
      "id": "total",
      "type": "Label",
      "layout": { "left": 450, "top": 30, "width": 200, "height": 24 },
      "props": { "text": "=concat('Total ', sum(ds.dsEmp.salary), ' of ds.dsEmp.name')" }
    },
    {
      "id": "grid",
      "type": "Grid",
      "layout": { "left": 20, "top": 350, "width": 700, "height": 200 },
      "props": {
        "columns": [
          { "id": "empNo", "width": 80 },
          { "id": "name", "width": 160 },
          { "id": "salary", "width": 100 }
        ],
        "headerRows": [{ "cells": [{ "text": "No" }, { "text": "Name" }, { "text": "Salary" }] }],
        "recordRows": [
          {
            "cells": [
              { "field": "empNo" },
              { "field": "name", "editor": "text" },
              { "field": "salary", "format": "#,##0.00" }
            ]
          }
        ],
        "footerRows": [{ "cells": [{ "text": "Total", "colSpan": 2 }, { "value": "=sum(salary)" }] }]
      },
      "bind": { "dataset": "dsEmp" }
    },
    {
      "id": "tabs",
      "type": "Tabs",
      "layout": { "left": 450, "top": 100, "width": 300, "height": 200 },
      "children": [{ "id": "page1", "type": "Panel", "layout": { "left": 0, "top": 0, "width": 100, "height": 100 } }]
    },
    {
      "id": "plain",
      "type": "Button",
      "layout": { "left": 450, "top": 320, "width": 80, "height": 24 }
    }
  ]
}
`;
