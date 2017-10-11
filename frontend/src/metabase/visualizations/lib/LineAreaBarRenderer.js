/* @flow weak */

import crossfilter from "crossfilter";
import d3 from "d3";
import dc from "dc";
import moment from "moment";
import _ from "underscore";
import { updateIn, getIn } from "icepick";

import {
    computeSplit,
    getFriendlyName,
    getXValues,
    colorShades
} from "./utils";

import { dimensionIsTimeseries, minTimeseriesUnit, computeTimeseriesDataInverval } from "./timeseries";

import { dimensionIsNumeric, computeNumericDataInverval } from "./numeric";

import { applyChartTimeseriesXAxis, applyChartQuantitativeXAxis, applyChartOrdinalXAxis, applyChartYAxis } from "./apply_axis";

import { applyChartTooltips } from "./apply_tooltips";

import {
    HACK_parseTimestamp,
    NULL_DIMENSION_WARNING,
    fillMissingValues,
    forceSortedGroupsOfGroups,
    hasRemappingAndValuesAreStrings,
    initChart, // TODO - probably better named something like `initChartParent`
    makeIndexMap,
    reduceGroup
} from "./renderer_utils";

import lineAndBarOnRender from "./LineAreaBarPostRenderer";

import { formatNumber } from "metabase/lib/formatting";
import { isStructured } from "metabase/meta/Card";

import { datasetContainsNoResults } from "metabase/lib/dataset";
import { updateDateTimeFilter, updateNumericFilter } from "metabase/qb/lib/actions";

import { lineAddons } from "./graph/addons"
import { initBrush } from "./graph/brush";

import type { VisualizationProps } from "metabase/meta/types/Visualization"


const BAR_PADDING_RATIO = 0.2;
const DEFAULT_INTERPOLATION = "linear";

// max number of points to "fill"
// TODO: base on pixel width of chart?
const MAX_FILL_COUNT = 10000;

const UNAGGREGATED_DATA_WARNING = (col) => `"${getFriendlyName(col)}" is an unaggregated field: if it has more than one value at a point on the x-axis, the values will be summed.`


/************************************************************ PROPERTIES ************************************************************/

function isTimeseries(settings) {
    return settings["graph.x_axis.scale"] === "timeseries";
}

function isQuantitative(settings) {
    const xAxisScale = settings["graph.x_axis.scale"];
    return xAxisScale === "linear" || xAxisScale === "log" || xAxisScale === "pow";
}

function isHistogram(settings) {
    return settings["graph.x_axis.scale"] === "histogram";
}

function isOrdinal(settings) {
    return !isTimeseries(settings) && !isHistogram(settings);
}

// bar histograms have special tick formatting:
// * aligned with beginning of bar to show bin boundaries
// * label only shows beginning value of bin
// * includes an extra tick at the end for the end of the last bin
function isHistogramBar({ settings, chartType }) {
    return isHistogram(settings) && chartType === "bar";
}

function isStacked(settings, datas) {
    return settings["stackable.stack_type"] && datas.length > 1;
}

function isNormalized (settings, datas) {
    return isStacked(settings, datas) && settings["stackable.stack_type"] === "normalized";
}

// find the first nonempty single series
function getFirstNonEmptySeries(series) {
    return _.find(series, (s) => !datasetContainsNoResults(s.data));
}

function isDimensionTimeseries(series) {
    return dimensionIsTimeseries(getFirstNonEmptySeries(series).data);
}

function isDimensionNumeric(series) {
    return dimensionIsNumeric(getFirstNonEmptySeries(series).data);
}

function isRemappedToString(series) {
    return hasRemappingAndValuesAreStrings(getFirstNonEmptySeries(series).data);
}

// is this a dashboard multiseries?
// TODO: better way to detect this?
function isMultiCardSeries(series) {
    return series.length > 1 && getIn(series, [0, "card", "id"]) !== getIn(series, [1, "card", "id"]);
}

function enableBrush(series, onChangeCardAndRun) {
    return !!(onChangeCardAndRun &&
              !isMultiCardSeries(series) &&
              isStructured(series[0].card) &&
              !isRemappedToString(series));
}


/************************************************************ SETUP ************************************************************/

function checkSeriesIsValid({ series, maxSeries }) {
    if (getFirstNonEmptySeries(series).data.cols.length < 2) {
        throw new Error("This chart type requires at least 2 columns.");
    }

    if (series.length > maxSeries) {
        throw new Error(`This chart type doesn't support more than ${maxSeries} series of data.`);
    }
}

function getDatas({ settings, series }, warn) {
    return series.map((s, index) =>
        s.data.rows.map(row => {
            let newRow = [
                // don't parse as timestamp if we're going to display as a quantitative scale, e.x. years and Unix timestamps
                (isDimensionTimeseries(series) && !isQuantitative(settings)) ?
                HACK_parseTimestamp(row[0], s.data.cols[0].unit, warn)
                : isDimensionNumeric(series) ?
                row[0]
                :
                String(row[0])
                , ...row.slice(1)
            ]
            // $FlowFixMe: _origin not typed
            newRow._origin = row._origin;
            return newRow;
        })
    );
}

function getXInterval({ settings, series }, xValues) {
    if (isTimeseries(settings)) {
        // compute the interval
        let unit = minTimeseriesUnit(series.map(s => s.data.cols[0].unit));
        return computeTimeseriesDataInverval(xValues, unit);
    } else if (isQuantitative(settings) || isHistogram(settings)) {
        // Get the bin width from binning_info, if available
        // TODO: multiseries?
        const binningInfo = getFirstNonEmptySeries(series).data.cols[0].binning_info;
        if (binningInfo) return binningInfo.bin_width;

        // Otherwise try to infer from the X values
        return computeNumericDataInverval(xValues);
    }
}

function getXAxisProps(props, datas) {
    const xValues = getXValues(datas, props.chartType);

    return {
        xValues,
        xDomian: d3.extent(xValues),
        xInterval: getXInterval(props, xValues)
    };
}


function fillMissingValuesInDatas(props, { xValues, xDomain, xInterval }, datas) {
    const { settings } = props;
    if (settings["line.missing"] === "zero" || settings["line.missing"] === "none") {
        const fillValue = settings["line.missing"] === "zero" ? 0 : null;
        if (isTimeseries(settings)) {
            // $FlowFixMe
            const { interval, count } = xInterval;
            if (count <= MAX_FILL_COUNT) {
                // replace xValues with
                xValues = d3.time[interval]
                            .range(xDomain[0], moment(xDomain[1]).add(1, "ms"), count)
                            .map(d => moment(d));
                datas = fillMissingValues(
                    datas,
                    xValues,
                    fillValue,
                    (m) => d3.round(m.toDate().getTime(), -1) // sometimes rounds up 1ms?
                );
            }
        }
        if (isQuantitative(settings) || isHistogram(settings)) {
            // $FlowFixMe
            const count = Math.abs((xDomain[1] - xDomain[0]) / xInterval);
            if (count <= MAX_FILL_COUNT) {
                let [start, end] = xDomain;
                if (isHistogramBar(props)) {
                    // NOTE: intentionally add an end point for bar histograms
                    // $FlowFixMe
                    end += xInterval * 1.5
                } else {
                    // NOTE: avoid including endpoint due to floating point error
                    // $FlowFixMe
                    end += xInterval * 0.5
                }
                xValues = d3.range(start, end, xInterval);
                datas = fillMissingValues(
                    datas,
                    xValues,
                    fillValue,
                    // NOTE: normalize to xInterval to avoid floating point issues
                    (v) => Math.round(v / xInterval)
                );
            }
        } else {
            datas = fillMissingValues(
                datas,
                xValues,
                fillValue
            );
        }
    }
}


function getDimensionAndGroups({ settings, chartType, series }, datas, warn) {
    let dimension, groups;
    let dataset = crossfilter();

    if (chartType === "scatter") {
        datas.map(data => dataset.add(data));

        dimension = dataset.dimension(row => row);
        groups = datas.map(data => {
            let dim = crossfilter(data).dimension(row => row);
            return [
                dim.group().reduceSum((d) => d[2] || 1)
            ]
        });
    } else if (isStacked) {
        const isNormalized = isNormalized(settings, datas);
        // get the sum of the metric for each dimension value in order to scale
        let scaleFactors = {};
        if (isNormalized) {
            for (let data of datas) {
                for (let [d, m] of data) {
                    scaleFactors[d] = (scaleFactors[d] || 0) + m;
                }
            }

            // $FlowFixMe
            series = series.map(s => updateIn(s, ["data", "cols", 1], (col) => ({
                ...col,
                display_name: "% " + getFriendlyName(col)
            })));
        }

        datas.map((data, i) =>
            dataset.add(data.map(d => ({
                [0]: d[0],
                [i + 1]: isNormalized ? (d[1] / scaleFactors[d[0]]) : d[1]
            })))
        );

        dimension = dataset.dimension(d => d[0]);
        groups = [
            datas.map((data, seriesIndex) =>
                reduceGroup(dimension.group(), seriesIndex + 1, () => warn(UNAGGREGATED_DATA_WARNING(series[seriesIndex].data.cols[0])))
            )
        ];
    } else {
        datas.map(data => dataset.add(data));

        dimension = dataset.dimension(d => d[0]);
        groups = datas.map((data, seriesIndex) => {
            // If the value is empty, pass a dummy array to crossfilter
            data = data.length > 0 ? data : [[null, null]];

            let dim = crossfilter(data).dimension(d => d[0]);

            return data[0].slice(1).map((_, metricIndex) =>
                reduceGroup(dim.group(), metricIndex + 1, () => warn(UNAGGREGATED_DATA_WARNING(series[seriesIndex].data.cols[0])))
            );
        });
    }

    return { dataset, groups };
}


function getYAxisSplit({ settings, chartType, isScalarSeries, series }, datas, yExtents) {
    // don't auto-split if the metric columns are all identical, i.e. it's a breakout multiseries
    const hasDifferentYAxisColumns = _.uniq(series.map(s => s.data.cols[1])).length > 1;
    if (!isScalarSeries && chartType !== "scatter" && !isStacked(settings, datas) && hasDifferentYAxisColumns && settings["graph.y_axis.auto_split"] !== false) {
        return computeSplit(yExtents);
    }
    return [series.map((s,i) => i)];
}

function getYAxisSplitLeftAndRight(series, yAxisSplit, yExtents) {
    return yAxisSplit.map(indexes => ({
        series: indexes.map(index => series[index]),
        extent: d3.extent([].concat(...indexes.map(index => yExtents[index])))
    }));
}


function getIsSplitYAxis(left, right) {
    return (right && right.series.length) && (left && left.series.length > 0);
}

function getYAxisProps(props, groups, datas) {
    const yExtents = groups.map(group => d3.extent(group[0].all(), d => d.value));
    const yAxisSplit = getYAxisSplit(props, datas, yExtents);

    const [ yLeftSplit, yRightSplit ] = getYAxisSplitLeftAndRight(props.series, yAxisSplit, yExtents);

    return {
        yExtents,
        yAxisSplit,
        yExtent: d3.extent([].concat(...yExtents)),
        yLeftSplit,
        yRightSplit,
        isSplit: getIsSplitYAxis(yLeftSplit, yRightSplit)
    };
}

/// make the `onBrushChange()` and `onBrushEnd()` functions we'll use later, as well as an `isBrushing()` function to check
/// current status.
function makeBrushChangeFunctions({ series, onChangeCardAndRun }) {
    let _isBrushing = false;

    const isBrushing = () => _isBrushing;

    function onBrushChange() {
        _isBrushing = true;
    }

    function onBrushEnd(range) {
        _isBrushing = false;
        if (range) {
            const column = series[0].data.cols[0];
            const card = series[0].card;
            const [start, end] = range;
            if (isDimensionTimeseries(series)) {
                onChangeCardAndRun({ nextCard: updateDateTimeFilter(card, column, start, end), previousCard: card });
            } else {
                onChangeCardAndRun({ nextCard: updateNumericFilter(card, column, start, end), previousCard: card });
            }
        }
    }

    return { isBrushing, onBrushChange, onBrushEnd };
}


/************************************************************ INDIVIDUAL CHART SETUP ************************************************************/

function getDcjsChart(cardType, parent) {
    switch (cardType) {
        case "line":    return lineAddons(dc.lineChart(parent));
        case "area":    return lineAddons(dc.lineChart(parent));
        case "bar":     return dc.barChart(parent);
        case "scatter": return dc.bubbleChart(parent);
        default:        return dc.barChart(parent);
    }
}

function applyChartLineBarSettings(chart, settings, chartType) {
    // LINE/AREA:
    // for chart types that have an 'interpolate' option (line/area charts), enable based on settings
    if (chart.interpolate) chart.interpolate(settings["line.interpolate"] || DEFAULT_INTERPOLATION);

    // AREA:
    if (chart.renderArea) chart.renderArea(chartType === "area");

    // BAR:
    if (chart.barPadding) chart.barPadding(BAR_PADDING_RATIO)
                               .centerBar(settings["graph.x_axis.scale"] !== "ordinal");
}



// TODO - give this a good name when I figure out what it does
function doScatterChartStuff(chart, datas, index, { yExtent, yExtents }) {
    chart
        .keyAccessor((d) => d.key[0])
        .valueAccessor((d) => d.key[1])

    if (chart.radiusValueAccessor) {
        const isBubble = datas[index][0].length > 2;
        if (isBubble) {
            const BUBBLE_SCALE_FACTOR_MAX = 64;
            chart
                .radiusValueAccessor((d) => d.value)
                .r(d3.scale.sqrt()
                     .domain([0, yExtent[1] * BUBBLE_SCALE_FACTOR_MAX])
                     .range([0, 1])
                );
        } else {
            chart.radiusValueAccessor((d) => 1)
            chart.MIN_RADIUS = 3
        }
        chart.minRadiusWithLabel(Infinity);
    }
}


function setColors({ settings, chartType }, chart, group, groups, index) {
    const colors = settings["graph.colors"];

    // multiple series
    if (groups.length > 1 || chartType === "scatter") {
        // multiple stacks
        if (group.length > 1) {
            // compute shades of the assigned color
            chart.ordinalColors(colorShades(colors[index % colors.length], group.length))
        } else {
            chart.colors(colors[index % colors.length])
        }
    } else {
        chart.ordinalColors(colors)
    }
}

/// Return a sequence of little charts for each of the groups.
function getCharts(props, yAxisProps, parent, datas, groups, dimension, { onBrushChange, onBrushEnd }) {
    const { settings, chartType, series, onChangeCardAndRun } = props;
    const { yAxisSplit } = yAxisProps;

    return groups.map((group, index) => {
        let chart = getDcjsChart(chartType, parent);

        if (enableBrush(series, onChangeCardAndRun)) initBrush(parent, chart, onBrushChange, onBrushEnd);

        // disable clicks
        chart.onClick = () => {};

        chart.dimension(dimension)
             .group(group[0])
             .transitionDuration(0)
             .useRightYAxis(yAxisSplit.length > 1 && yAxisSplit[1].includes(index));

        if (chartType === "scatter") doScatterChartStuff(chart, datas, index, yAxisProps);

        if (chart.defined) {
            chart.defined(
                settings["line.missing"] === "none" ?
                (d) => d.y != null :
                     (d) => true
            );
        }

        setColors(props, chart, group, groups, index);

        for (var i = 1; i < group.length; i++) {
            chart.stack(group[i])
        }

        applyChartLineBarSettings(chart, settings, chartType);

        return chart;
    });
}


/************************************************************ OTHER SETUP ************************************************************/

/// make an appropriate `onGoalHover` function.
function getOnGoalHover({ settings, onHoverChange }, xDomain, charts) {
    if (!settings["graph.show_goal"]) return () => {};

    const goalValue = settings["graph.goal_value"];
    const goalData = [[xDomain[0], goalValue], [xDomain[1], goalValue]];
    const goalDimension = crossfilter(goalData).dimension(d => d[0]);
    // Take the last point rather than summing in case xDomain[0] === xDomain[1], e.x. when the chart
    // has just a single row / datapoint
    const goalGroup = goalDimension.group().reduce((p,d) => d[1], (p,d) => p, () => 0);
    const goalIndex = charts.length;
    let goalChart = dc.lineChart(parent)
                      .dimension(goalDimension)
                      .group(goalGroup)
                      .on('renderlet', function (chart) {
                          // remove "sub" class so the goal is not used in voronoi computation
                          chart.select(".sub._"+goalIndex)
                               .classed("sub", false)
                               .classed("goal", true);
                      });
    charts.push(goalChart);

    return (element) => {
        onHoverChange(element && {
            element,
            data: [{ key: "Goal", value: goalValue }]
        });
    }

}

function applyXAxisSettings({ settings, series }, { xValues, xDomain, xInterval }, parent) {
    if (isTimeseries(settings)) {
        applyChartTimeseriesXAxis(parent, settings, series, xValues, xDomain, xInterval);
    } else if (isQuantitative(settings)) {
        applyChartQuantitativeXAxis(parent, settings, series, xValues, xDomain, xInterval);
    } else {
        applyChartOrdinalXAxis(parent, settings, series, xValues);
    }

}

function applyYAxisSettings({ settings }, { yLeftSplit, yRightSplit }, parent) {
    if (yLeftSplit && yLeftSplit.series.length > 0) {
        applyChartYAxis(parent, settings, yLeftSplit.series, yLeftSplit.extent, "left");
    }
    if (yRightSplit && yRightSplit.series.length > 0) {
        applyChartYAxis(parent, settings, yRightSplit.series, yRightSplit.extent, "right");
    }
}


// TODO - better name
function doGroupedBarStuff(parent) {
    parent.on("renderlet.grouped-bar", function (chart) {
        // HACK: dc.js doesn't support grouped bar charts so we need to manually resize/reposition them
        // https://github.com/dc-js/dc.js/issues/558
        let barCharts = chart.selectAll(".sub rect:first-child")[0].map(node => node.parentNode.parentNode.parentNode);
        if (barCharts.length > 0) {
            let oldBarWidth = parseFloat(barCharts[0].querySelector("rect").getAttribute("width"));
            let newBarWidthTotal = oldBarWidth / barCharts.length;
            let seriesPadding =
                newBarWidthTotal < 4 ? 0 :
                newBarWidthTotal < 8 ? 1 :
                2;
            let newBarWidth = Math.max(1, newBarWidthTotal - seriesPadding);

            chart.selectAll("g.sub rect").attr("width", newBarWidth);
            barCharts.forEach((barChart, index) => {
                barChart.setAttribute("transform", "translate(" + ((newBarWidth + seriesPadding) * index) + ", 0)");
            });
        }
    });
}

// TODO - better name
function doHistogramBarStuff(parent) {
    parent.on("renderlet.histogram-bar", function (chart) {
        let barCharts = chart.selectAll(".sub rect:first-child")[0].map(node => node.parentNode.parentNode.parentNode);
        if (barCharts.length > 0) {
            // manually size bars to fill space, minus 1 pixel padding
            const bars = barCharts[0].querySelectorAll("rect");
            let barWidth = parseFloat(bars[0].getAttribute("width"));
            let newBarWidth = parseFloat(bars[1].getAttribute("x")) - parseFloat(bars[0].getAttribute("x")) - 1;
            if (newBarWidth > barWidth) {
                chart.selectAll("g.sub .bar").attr("width", newBarWidth);
            }

            // shift half of bar width so ticks line up with start of each bar
            for (const barChart of barCharts) {
                barChart.setAttribute("transform", `translate(${barWidth / 2}, 0)`);
            }
        }
    });
}

function setupTooltips({ settings, series, isScalarSeries, onHoverChange, onVisualizationClick }, datas, parent, { isBrushing }) {
    applyChartTooltips(parent, series, isStacked(settings, datas), isNormalized(settings, datas), isScalarSeries, (hovered) => {
        // disable tooltips while brushing
        if (onHoverChange && !isBrushing()) {
            // disable tooltips on lines
            if (hovered && hovered.element && hovered.element.classList.contains("line")) {
                delete hovered.element;
            }
            onHoverChange(hovered);
        }
    }, onVisualizationClick);
}


/************************************************************ PUTTING IT ALL TOGETHER ************************************************************/

type LineAreaBarProps = VisualizationProps & {
    chartType: "line" | "area" | "bar" | "scatter",
    isScalarSeries: boolean,
    maxSeries: number
}

export default function lineAreaBar(element: Element, props: LineAreaBarProps) {
    const { onRender, chartType, isScalarSeries, settings} = props;

    const warnings = {};
    const warn = (id) => {
        warnings[id] = (warnings[id] || 0) + 1;
    }

    checkSeriesIsValid(props);

    // force histogram to be ordinal axis with zero-filled missing points
    if (isHistogram(settings)) {
        settings["line.missing"]       = "zero";
        settings["graph.x_axis.scale"] = "ordinal"
    }

    let datas      = getDatas(props, warn);
    let xAxisProps = getXAxisProps(props, datas);

    fillMissingValuesInDatas(props, xAxisProps, datas);

    if (isScalarSeries) xAxisProps.xValues = datas.map(data => data[0][0]); // TODO - what is this for?

    let { dimension, groups } = getDimensionAndGroups(props, datas, warn);

    const yAxisProps = getYAxisProps(props, groups, datas);

    // Don't apply to linear or timeseries X-axis since the points are always plotted in order
    if (!isTimeseries(settings) && !isQuantitative(settings)) forceSortedGroupsOfGroups(groups, makeIndexMap(xAxisProps.xValues));

    let parent = dc.compositeChart(element);
    initChart(parent, element);

    const brushChangeFunctions = makeBrushChangeFunctions(props);

    let charts      = getCharts(props, yAxisProps, parent, datas, groups, dimension, brushChangeFunctions);
    let onGoalHover = getOnGoalHover(props, xAxisProps.xDomain, charts);

    parent.compose(charts);

    if      (groups.length > 1 && !props.isScalarSeries) doGroupedBarStuff(parent);
    else if (isHistogramBar(props))                      doHistogramBarStuff(parent);

    // HACK: compositeChart + ordinal X axis shenanigans. See https://github.com/dc-js/dc.js/issues/678 and https://github.com/dc-js/dc.js/issues/662
    parent._rangeBandPadding(chartType === "bar" ? BAR_PADDING_RATIO : 1) //

    applyXAxisSettings(props, xAxisProps, parent);

    // override tick format for bars. ticks are aligned with beginning of bar, so just show the start value
    if (isHistogramBar(props)) parent.xAxis().tickFormat(d => formatNumber(d));

    applyYAxisSettings(props, yAxisProps, parent);

    setupTooltips(props, datas, parent, brushChangeFunctions);

    parent.render();

    // apply any on-rendering functions (this code lives in `LineAreaBarPostRenderer`)
    lineAndBarOnRender(parent, settings, onGoalHover, yAxisProps.isSplit, isStacked(settings, datas));

    // only ordinal axis can display "null" values
    if (isOrdinal(settings)) delete warnings[NULL_DIMENSION_WARNING];

    if (onRender) onRender({
        yAxisProps.yAxisSplit,
        warnings: Object.keys(warnings)
    });

    return parent;
}

export const lineRenderer    = (element, props) => lineAreaBar(element, { ...props, chartType: "line" });
export const areaRenderer    = (element, props) => lineAreaBar(element, { ...props, chartType: "area" });
export const barRenderer     = (element, props) => lineAreaBar(element, { ...props, chartType: "bar" });
export const scatterRenderer = (element, props) => lineAreaBar(element, { ...props, chartType: "scatter" });
